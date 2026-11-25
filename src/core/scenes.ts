import type { SceneDef } from './types';

// 四种比对场景。kelvin 为光源色温，ambientLux 用于健侧瞳孔估计，
// flash>0 时叠加手机闪光灯的同轴硬高光。
export const SCENES: SceneDef[] = [
  {
    id: 'clinic',
    name: '诊室灯',
    kelvin: 4800,
    intensity: 1.0,
    exposureEv: 0,
    ambientLux: 650,
    flash: 0,
    lightDir: [-0.35, -0.45],
    icon: 'lamp',
  },
  {
    id: 'daylight',
    name: '窗边日光',
    kelvin: 6200,
    intensity: 1.12,
    exposureEv: 0.15,
    ambientLux: 1400,
    flash: 0,
    lightDir: [-0.7, -0.35],
    icon: 'sun',
  },
  {
    id: 'warm',
    name: '暖色室内灯',
    kelvin: 2700,
    intensity: 0.78,
    exposureEv: -0.35,
    ambientLux: 90,
    flash: 0,
    lightDir: [-0.2, -0.5],
    icon: 'warm',
  },
  {
    id: 'flash',
    name: '手机闪光灯',
    kelvin: 6600,
    intensity: 0.92,
    exposureEv: 0.35,
    ambientLux: 300,
    flash: 1,
    lightDir: [0.0, -0.12],
    icon: 'flash',
  },
];

export function sceneById(id: string): SceneDef {
  return SCENES.find((s) => s.id === id) ?? SCENES[0];
}
