// 展示版不會呼叫 Claude API，用空模組取代以縮小檔案
export default class Anthropic {
  constructor() {
    throw new Error('展示版不支援');
  }
}
export function betaTool() {
  throw new Error('展示版不支援');
}
