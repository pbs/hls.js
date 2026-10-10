import { expect, use } from 'chai';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import LevelController from '../../../src/controller/level-controller';
import { ErrorDetails } from '../../../src/errors';
import { Events } from '../../../src/events';
import { LoadStats } from '../../../src/loader/load-stats';
import M3U8Parser from '../../../src/loader/m3u8-parser';
import PlaylistLoader from '../../../src/loader/playlist-loader';
import { PlaylistLevelType } from '../../../src/types/loader';
import HlsMock from '../../mocks/hls.mock';
import { multivariantPlaylistWithPathways } from '../controller/level-controller';
import type Hls from '../../../src/hls';
import type { LevelDetails } from '../../../src/loader/level-details';
import type { ArchiveLoadedData, ErrorData } from '../../../src/types/events';
import type {
  LoaderCallbacks,
  LoaderConfiguration,
  PlaylistLoaderContext,
} from '../../../src/types/loader';

use(sinonChai);

describe('PlaylistLoader tests', function () {
  const sandbox = sinon.createSandbox();
  let hls: Hls; // HlsMock
  let playlistLoader: PlaylistLoader;
  let levelController: LevelController; // level-controller finishes manifest parsing
  let response;

  beforeEach(function () {
    hls = new HlsMock({}) as unknown as Hls;
    playlistLoader = new PlaylistLoader(hls);
    levelController = new LevelController(hls, null);
  });

  afterEach(function () {
    sandbox.restore();
    playlistLoader.destroy();
    levelController.destroy();
  });

  it('handles multivariant playlist loading and parsing (with level-controller) on MANIFEST_LOADING', function () {
    return new Promise<void>((resolve, reject) => {
      const stats = new LoadStats();
      const networkDetails = new Response('ok');
      sinon.stub(playlistLoader as any, 'createInternalLoader').returns({
        load: (
          context: PlaylistLoaderContext,
          config: LoaderConfiguration,
          callback: LoaderCallbacks<PlaylistLoaderContext>,
        ) => {
          expect(context.type).eq('manifest');
          Promise.resolve()
            .then(() => {
              response = { data: multivariantPlaylistWithPathways };
              callback.onSuccess(response, stats, context, networkDetails);
            })
            .catch(reject);
        },
        abort: () => {},
      });

      hls.on(Events.MANIFEST_LOADED, (type, data) => {
        expect(data).includes({
          url: 'http://example.cpm/program.m3u8',
          stats,
          networkDetails,
          captions: undefined,
          sessionData: null,
          sessionKeys: null,
          startTimeOffset: null,
          variableList: null,
        });
        expect(data.levels, 'levels.length').to.have.lengthOf(30);
        expect(data.audioTracks, 'audioTracks.length').to.have.lengthOf(6);
        expect(data.subtitles, 'subtitles.length').to.have.lengthOf(6);
        expect(data.contentSteering, 'contentSteering').to.includes({
          uri: 'http://example.com/manifest.json',
          pathwayId: 'Bar',
        });
        expect(stats.parsing.start, 'parsing.start').to.be.greaterThan(0);
        expect(stats.parsing.end, 'parsing.end').to.be.greaterThanOrEqual(
          stats.parsing.start,
        );

        resolve();
      });

      hls.trigger(Events.MANIFEST_LOADING, {
        url: 'http://example.cpm/program.m3u8',
      });
    });
  });

  describe('Playlist Archives', function () {
    const archiveText = `#EXT-X-MEDIA-SEQUENCE:1
#EXT-X-DISCONTINUITY-SEQUENCE:0
#EXTINF:5,
1.m4s
#EXTINF:5,
2.m4s`;
    let parent: LevelDetails;
    let requests: {
      context: PlaylistLoaderContext;
      config: LoaderConfiguration;
      callbacks: LoaderCallbacks<PlaylistLoaderContext>;
      aborted: boolean;
    }[];
    let loaded: ArchiveLoadedData[];
    let errors: ErrorData[];

    beforeEach(function () {
      parent = M3U8Parser.parseLevelPlaylist(
        `#EXTM3U
#EXT-X-TARGETDURATION:5
#EXT-X-MEDIA-SEQUENCE:13
#EXT-X-ARCHIVE:FIRST-MSN=1,DURATION=10,URI="a1.m3u8a"
#EXT-X-ARCHIVE:FIRST-MSN=3,DURATION=50,URI="a3.m3u8a"
#EXTINF:5,
13.m4s`,
        'http://example.com/live/v.m3u8',
        0,
        PlaylistLevelType.MAIN,
        0,
        null,
      );
      requests = [];
      loaded = [];
      errors = [];
      hls.config.pLoader = class {
        context = null;
        stats = new LoadStats();
        load(context, config, callbacks) {
          requests.push({ context, config, callbacks, aborted: false });
        }
        abort() {
          requests[requests.length - 1].aborted = true;
        }
        destroy() {}
      } as any;
      hls.on(Events.ARCHIVE_LOADED, (_, data) => loaded.push(data));
      hls.on(Events.ERROR, (_, data) => errors.push(data));
    });

    const loadArchive = (index: number, type = PlaylistLevelType.MAIN) => {
      const archive = parent.archives![index];
      hls.trigger(Events.ARCHIVE_LOADING, {
        archive,
        levelDetails: parent,
        type,
        level: 0,
      });
      return archive;
    };

    it('loads and parses archives with the playlist load policy', function () {
      const archive = loadArchive(0);
      expect(requests).to.have.lengthOf(1);
      const { context, config, callbacks } = requests[0];
      expect(context.type).to.equal('archive');
      expect(context.url).to.equal('http://example.com/live/a1.m3u8a');
      expect(config.loadPolicy).to.equal(
        hls.config.playlistLoadPolicy!.default,
      );
      expect(config.loadPolicy.errorRetry).to.not.be.null;
      expect(archive.loader).to.not.be.null;

      callbacks.onSuccess(
        { url: context.url, data: archiveText },
        new LoadStats(),
        context,
        null,
      );
      expect(archive.loader).to.be.null;
      expect(loaded).to.have.lengthOf(1);
      expect(loaded[0].archive).to.equal(archive);
      expect(loaded[0].details.startSN).to.equal(1);
      expect(loaded[0].details.fragments).to.have.lengthOf(2);
      expect(loaded[0].details.targetduration).to.equal(5);
    });

    it('loads archives of different renditions without aborting each other', function () {
      loadArchive(0);
      loadArchive(1, PlaylistLevelType.AUDIO);
      expect(requests).to.have.lengthOf(2);
      expect(requests[0].aborted).to.be.false;
      requests.forEach(({ context, callbacks }) =>
        callbacks.onSuccess(
          { url: context.url, data: archiveText },
          new LoadStats(),
          context,
          null,
        ),
      );
      expect(loaded.map((data) => data.type)).to.deep.equal([
        PlaylistLevelType.MAIN,
        PlaylistLevelType.AUDIO,
      ]);
    });

    it('reports load, timeout and parsing errors as non-fatal', function () {
      const archive = loadArchive(0);
      const { context, callbacks } = requests[0];
      callbacks.onError(
        { code: 404, text: 'Not Found' },
        context,
        null,
        new LoadStats(),
      );
      callbacks.onTimeout(new LoadStats(), context, null);
      callbacks.onSuccess(
        { url: context.url, data: '<html>Not Found</html>' },
        new LoadStats(),
        context,
        null,
      );
      expect(errors.map((data) => data.details)).to.deep.equal([
        ErrorDetails.ARCHIVE_LOAD_ERROR,
        ErrorDetails.ARCHIVE_LOAD_TIMEOUT,
        ErrorDetails.ARCHIVE_PARSING_ERROR,
      ]);
      errors.forEach((data) => {
        expect(data.fatal).to.be.false;
        expect(data.archive).to.equal(archive);
      });
      expect(errors[0].response?.code).to.equal(404);
      expect(archive.error).to.be.an('error');
      expect(archive.loader).to.be.null;
      expect(loaded).to.have.lengthOf(0);
    });
  });
});
