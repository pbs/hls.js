import type { LevelDetails } from './level-details';
import type { Loader, PlaylistLoaderContext } from '../types/loader';
import type { AttrList } from '../utils/attr-list';

export class PlaylistArchive {
  public attr: AttrList;
  public url: string;
  public details: LevelDetails | null = null;
  public start: number = NaN;
  public loader: Loader<PlaylistLoaderContext> | null = null;
  public error: Error | null = null;

  constructor(attr: AttrList, url: string) {
    this.attr = attr;
    this.url = url;
  }

  get firstSN(): number {
    return this.attr.decimalInteger('FIRST-MSN');
  }

  get duration(): number {
    return this.attr.decimalFloatingPoint('DURATION');
  }

  get startDate(): Date | null {
    const startProgramDate = this.attr['START-PROGRAM-DATE'];
    return startProgramDate ? new Date(startProgramDate) : null;
  }

  get isValid(): boolean {
    return !!this.attr.URI && this.firstSN >= 0 && this.duration >= 0;
  }
}
