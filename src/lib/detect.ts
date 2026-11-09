// Roda o MediaPipe no navegador: a foto não sai do aparelho.
import { FaceLandmarker, HandLandmarker, PoseLandmarker } from '@mediapipe/tasks-vision'
import wasmLoaderPath from '@mediapipe/tasks-vision/vision_wasm_internal.js?url'
import wasmBinaryPath from '@mediapipe/tasks-vision/vision_wasm_internal.wasm?url'
import { bodyVector, faceAngles, handVector, type Mode } from './features'

// Mesmos modelos de scripts/build_index.py.
const MODELS: Record<Mode, string> = {
  face: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
  body: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
  hand: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
}

const fileset = { wasmLoaderPath, wasmBinaryPath }
const loaded: Partial<Record<Mode, Promise<(img: HTMLImageElement) => number[] | undefined>>> = {}

async function load(mode: Mode) {
  const baseOptions = { modelAssetPath: MODELS[mode], delegate: 'CPU' as const }
  if (mode === 'face') {
    const t = await FaceLandmarker.createFromOptions(fileset, { baseOptions, numFaces: 1 })
    return (img: HTMLImageElement) => {
      const lm = t.detect(img).faceLandmarks[0]
      return lm && faceAngles(lm, img.naturalWidth, img.naturalHeight)
    }
  }
  if (mode === 'body') {
    const t = await PoseLandmarker.createFromOptions(fileset, { baseOptions, numPoses: 1 })
    return (img: HTMLImageElement) => {
      const world = t.detect(img).worldLandmarks[0]
      return world && bodyVector(world)
    }
  }
  const t = await HandLandmarker.createFromOptions(fileset, { baseOptions, numHands: 1 })
  return (img: HTMLImageElement) => {
    const world = t.detect(img).worldLandmarks[0]
    return world && handVector(world)
  }
}

// Carrega só o modelo do filtro escolhido, uma vez; se falhar, deixa tentar de novo.
export async function detect(mode: Mode, img: HTMLImageElement): Promise<number[] | undefined> {
  loaded[mode] ??= load(mode).catch((e) => {
    delete loaded[mode]
    throw e
  })
  return (await loaded[mode])(img)
}
