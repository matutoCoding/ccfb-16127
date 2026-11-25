import { generateSyntheticSequence, SYNTHETIC_IRIS_CASES } from '../src/synth/dataset';
import { buildHdr } from '../src/hdr/pipeline';
import { buildComparisonReport } from '../src/core/comparison';
import { makeMask } from '../src/core/image';
import { SCENE_ORDER } from '../src/render/scenes';
import { optimizeFixedPupil, fixedPupilFraction } from '../src/render/pupil';
const seq = generateSyntheticSequence(SYNTHETIC_IRIS_CASES[0], { size: 144, evs: [-2,-1,0,1,2] });
const { capture } = buildHdr(seq.frames, { id:'c', patientId:'p', eye:'right' });
const scheme = structuredClone(SYNTHETIC_IRIS_CASES[0].scheme);
const pup = optimizeFixedPupil(); scheme.fixedPupilMm=pup.fixedPupilMm; scheme.pupilFraction=fixedPupilFraction(pup.fixedPupilMm);
const report = buildComparisonReport({ id:'r',patientId:'p',captureId:capture.id,schemeId:scheme.id,healthyHdr:capture.hdr,healthyMask:makeMask(144,144),geometry:sequenceGeometry(seq,scheme.pupilFraction),scheme,curve:capture.response,ev:0,deltaEThreshold:3,renderSize:144,now:1 });
import { sequenceGeometry } from '../src/synth/dataset';
for (const s of SCENE_ORDER) {
  console.log(s, report.scenes[s].rings.map(r=>`r${r.ringIndex}:${r.meanDeltaE.toFixed(1)}`).join(' '));
}
