import { LIGHTING_SCENES } from '../src/render/scenes';
import { linearRgbToHex } from '../src/core/color';
for (const id of ['clinic','daylight','warm','flash'] as const) {
  const s = LIGHTING_SCENES[id];
  console.log(id, 'white=', linearRgbToHex(s.whitePoint as any), 'diffuse=', s.diffuseGain, 'spec=', s.specularGain);
}
