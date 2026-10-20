import type { LooitApi } from '../shared/ipc';

declare global {
  interface Window {
    looit: LooitApi;
  }
}
