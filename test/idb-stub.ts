import type { HdrCapture } from '../src/core/types';

/** 测试用最小 HdrCapture（含 Float32/Uint8 类型化数组，验证结构化克隆） */
export function HdrCaptureStub(): HdrCapture {
  const size = 4;
  const hdrData = new Float32Array(size * size * 3).fill(0.25);
  const maskData = new Uint8Array(size * size);
  maskData[3] = 1;
  return {
    id: 'cap-stub',
    patientId: 'p1',
    eye: 'right',
    createdAt: 123,
    exposures: [-1, 0, 1],
    alignment: { referenceIndex: 1, offsets: [{ dx: 0, dy: 0, score: 0 }] },
    response: {
      g: new Float32Array(3 * 256),
      inverseLut: new Float32Array(3 * 1024),
      logMin: -1,
      logMax: 1,
    },
    hdr: { width: size, height: size, data: hdrData },
    specularMask: { width: size, height: size, data: maskData },
    thumbnails: [],
    quality: { validPixelRatio: 0.95, fitRms: [0.1, 0.1, 0.1], warnings: [] },
  };
}
