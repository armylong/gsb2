/** Import analysis: original size, transparent bounds, stable identity. */

import type { SourceFrameInfo } from '../shared/types';
import type { RGBAImage } from '../shared/pixels';
import { findAlphaBounds } from '../shared/pixels';

export function analyzeImage(image: RGBAImage): Pick<SourceFrameInfo, 'sourceSize' | 'trim' | 'empty'> {
  const bounds = findAlphaBounds(image);
  if (!bounds) {
    return {
      sourceSize: { width: image.width, height: image.height },
      trim: { x: 0, y: 0, width: 0, height: 0 },
      empty: true,
    };
  }
  return {
    sourceSize: { width: image.width, height: image.height },
    trim: bounds,
    empty: false,
  };
}
