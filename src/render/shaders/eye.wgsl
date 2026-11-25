// 义眼片分层渲染着色器（scene-linear HDR 输出，rgba32float，不做 8 位截断）。
// 数学与 src/render/eyeModel.ts 的 CPU 参考实现保持一致；
// 颜料色号在 CPU 端解码为线性 RGB 后通过 uniform 传入。
struct Params {
  size: f32,
  irisRadius: f32,
  pupilFraction: f32,
  cx: f32,
  cy: f32,
  seed: f32,
  gloss: f32,
  wetness: f32,
  baseOpacity: f32,
  fiberCoverage: f32,
  fiberOpacity: f32,
  collarCoverage: f32,
  collarOpacity: f32,
  spotCoverage: f32,
  spotOpacity: f32,
  scleraCoverage: f32,
  vesselCoverage: f32,
  vesselOpacity: f32,
  hlX: f32,
  hlY: f32,
  hlSigma: f32,
  specularGain: f32,
  diffuseGain: f32,
  _pad0: f32,
  _pad1: f32,
};
struct Colors {
  base: vec3<f32>,
  fiber: vec3<f32>,
  collar: vec3<f32>,
  spot: vec3<f32>,
  sclera: vec3<f32>,
  yellow: vec3<f32>,
  vessel: vec3<f32>,
  white: vec3<f32>,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<uniform> colors: Colors;

fn hash2(ix: i32, iy: i32, seed: i32) -> f32 {
  var h: i32 = (ix * 374761393) ^ (iy * 668265263) ^ (seed * 224682251);
  h = (h ^ (h >> 13)) * 1274126177;
  h = h ^ (h >> 16);
  // 0x80000000 即 i32 最小负数 -2147483648，异或它把符号位翻转到 [0,2³¹)
  return f32(h ^ (-2147483648)) / 2147483648.0;
}
fn smooth01(t: f32) -> f32 { let c = clamp(t, 0.0, 1.0); return c * c * (3.0 - 2.0 * c); }
fn mix3(a: vec3<f32>, b: vec3<f32>, t: f32) -> vec3<f32> { return a + (b - a) * t; }

fn valueNoise(x: f32, y: f32, seed: i32) -> f32 {
  let x0 = i32(floor(x)); let y0 = i32(floor(y));
  let fx = smooth01(x - f32(x0)); let fy = smooth01(y - f32(y0));
  let v00 = hash2(x0, y0, seed);
  let v10 = hash2(x0 + 1, y0, seed);
  let v01 = hash2(x0, y0 + 1, seed);
  let v11 = hash2(x0 + 1, y0 + 1, seed);
  let top = mix(vec2(v00, v01), vec2(v10, v11), vec2(fx, fx));
  return mix(top.x, top.y, fy);
}
fn fbm(x: f32, y: f32, seed: i32) -> f32 {
  var amp = 0.5; var freq = 1.0; var sum = 0.0; var norm = 0.0;
  for (var o = 0; o < 4; o = o + 1) {
    sum = sum + amp * valueNoise(x * freq, y * freq, seed + o * 1013);
    norm = norm + amp; amp = amp * 0.5; freq = freq * 2.0;
  }
  return sum / norm;
}
fn fiberStrength(theta: f32, rNorm: f32, seed: i32, density: f32) -> f32 {
  let a = theta * 26.0 + fbm(cos(theta) * 3.0, sin(theta) * 3.0, seed) * 6.0;
  let ridge = 0.5 + 0.5 * sin(a + rNorm * 2.2);
  let sharp = pow(ridge, 3.0);
  let gate = fbm(cos(theta) * 6.0 + 5.0, sin(theta) * 6.0 + 5.0, seed + 7);
  return clamp(sharp * gate * density * 1.6, 0.0, 1.0);
}
fn collaretteStrength(theta: f32, rNorm: f32, seed: i32) -> f32 {
  let inner = 0.36 + 0.035 * sin(theta * 7.0 + fbm(2.0, 3.0, seed) * 4.0);
  let outer = 0.55 + 0.04 * sin(theta * 6.0 + 1.7);
  return clamp(smooth01((rNorm - inner) / 0.03) * (1.0 - smooth01((rNorm - (outer - 0.03)) / 0.03)), 0.0, 1.0);
}

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4<f32> {
  var p = array<vec2<f32>, 6>(
    vec2(-1.0, -1.0), vec2(1.0, -1.0), vec2(-1.0, 1.0),
    vec2(-1.0, 1.0), vec2(1.0, -1.0), vec2(1.0, 1.0),
  );
  return vec4(p[vi], 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) frag: vec4<f32>) -> @location(0) vec4<f32> {
  let px = frag.x; let py = frag.y;
  let size = params.size;
  let dx = (px - params.cx) / params.irisRadius;
  let dy = (py - params.cy) / params.irisRadius;
  let rIris = length(vec2(dx, dy));
  let eyeRadius = size * 0.48;
  let rEye = length(vec2(px - params.cx, py - params.cy)) / eyeRadius;
  let theta = atan2(dy, dx);
  let seed = i32(params.seed);
  var color: vec3<f32>;

  if (rEye > 1.0) {
    let bg = 0.02 * params.diffuseGain;
    return vec4(colors.white * bg, 1.0);
  }

  if (rIris >= 1.0) {
    let edgeShade = 1.0 - 0.35 * smooth01((rEye - 0.75) / 0.25);
    let yellowPatch = fbm(px / size * 7.0, py / size * 7.0, seed + 31) * (0.35 + 0.65 * rEye);
    var sclera = mix3(colors.sclera, colors.yellow, clamp(yellowPatch * params.scleraCoverage, 0.0, 1.0));
    // 血管密度近似（CPU 端随机游走的低频代理；近距离纹理由 CPU 路径精确给出）
    let vessel = clamp(fbm(dx * 5.0 + 3.0, dy * 5.0 - 2.0, seed + 63) * params.vesselCoverage * params.vesselOpacity * 1.4, 0.0, 1.0);
    sclera = mix3(sclera, colors.vessel, vessel);
    color = sclera * edgeShade;
  } else {
    let rootDarken = 1.0 - 0.45 * (1.0 - smooth01((rIris - params.pupilFraction) / 0.18));
    let stroma = 0.82 + 0.36 * fbm(dx * 4.0 + 9.0, dy * 4.0 + 9.0, seed + 3);
    let micro = 1.0 + (hash2(i32(px), i32(py), seed + 77) - 0.5) * 0.12 + (valueNoise(px * 0.9, py * 0.9, seed + 5) - 0.5) * 0.1;
    var iris = colors.base * (rootDarken * stroma * micro) * params.baseOpacity;
    if (rIris > params.pupilFraction) {
      let fStr = fiberStrength(theta, rIris, seed + 11, params.fiberCoverage) * params.fiberOpacity;
      iris = mix3(iris, colors.fiber, clamp(fStr, 0.0, 1.0));
      let cStr = collaretteStrength(theta, rIris, seed + 21) * params.collarCoverage * params.collarOpacity;
      iris = mix3(iris, colors.collar, clamp(cStr, 0.0, 1.0));
      // 色素斑用低频斑点近似
      let spot = clamp(fbm(dx * 9.0 + 4.0, dy * 9.0 - 3.0, seed + 41) * params.spotCoverage * params.spotOpacity * 1.3, 0.0, 1.0);
      iris = mix3(iris, colors.spot, spot);
    }
    let limbal = smooth01((rIris - 0.9) / 0.1);
    iris = iris * (1.0 - 0.55 * limbal);
    if (rIris <= params.pupilFraction) {
      let glow = 0.012 + 0.006 * fbm(dx * 10.0, dy * 10.0, seed + 51);
      iris = vec3(glow * 0.8, glow * 0.35, glow * 0.3);
    }
    color = iris;
  }

  color = color * colors.white * params.diffuseGain;

  if (rIris <= 1.06) {
    let fresnel = 0.12 * smooth01((rIris - 0.82) / 0.23);
    color = color + colors.white * (fresnel * params.diffuseGain);
    let dhl = length(vec2(px - params.hlX, py - params.hlY));
    let spec = exp(-(dhl * dhl) / (2.0 * params.hlSigma * params.hlSigma)) * params.specularGain * params.gloss;
    color = color + colors.white * (spec * 7.0);
  }
  if (rIris > 1.0) {
    let wet = params.wetness * 0.10 * max(0.0, 1.0 - rEye) * params.specularGain;
    color = color + colors.white * wet;
  }
  return vec4(max(color, vec3(0.0)), 1.0);
}
