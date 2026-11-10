// Roda o MediaPipe no navegador: a foto não sai do aparelho.
import { FaceLandmarker, HandLandmarker, ImageEmbedder, PoseLandmarker } from '@mediapipe/tasks-vision'
import wasmLoaderPath from '@mediapipe/tasks-vision/vision_wasm_internal.js?url'
import wasmBinaryPath from '@mediapipe/tasks-vision/vision_wasm_internal.wasm?url'
import { bodyVector, faceAngles, handVector, type Mode } from './features'

// Mesmos modelos de scripts/build_index.py.
// 'embed' = impressão de semelhança geral (qualquer imagem, não só pessoas).
export type Task = Mode | 'embed'

const MODELS: Record<Task, string> = {
  face: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
  body: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
  hand: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
  embed: 'https://storage.googleapis.com/mediapipe-models/image_embedder/mobilenet_v3_small/float32/latest/mobilenet_v3_small.tflite',
}

type Source = HTMLImageElement | HTMLCanvasElement // canvas = foto com recorte, giro ou brilho aplicados

const fileset = { wasmLoaderPath, wasmBinaryPath }
const loaded: Partial<Record<Task, Promise<(img: Source) => number[] | undefined>>> = {}

async function load(mode: Task) {
  const baseOptions = { modelAssetPath: MODELS[mode], delegate: 'CPU' as const }
  if (mode === 'embed') {
    const t = await ImageEmbedder.createFromOptions(fileset, { baseOptions, l2Normalize: true })
    return (img: Source) => Array.from(t.embed(img).embeddings[0].floatEmbedding ?? [])
  }
  if (mode === 'face') {
    const t = await FaceLandmarker.createFromOptions(fileset, { baseOptions, numFaces: 1 })
    return (img: Source) => {
      const lm = t.detect(img).faceLandmarks[0]
      return lm && faceAngles(lm, img.width, img.height)
    }
  }
  if (mode === 'body') {
    const t = await PoseLandmarker.createFromOptions(fileset, { baseOptions, numPoses: 1 })
    return (img: Source) => {
      const world = t.detect(img).worldLandmarks[0]
      return world && bodyVector(world)
    }
  }
  const t = await HandLandmarker.createFromOptions(fileset, { baseOptions, numHands: 1 })
  return (img: Source) => {
    const world = t.detect(img).worldLandmarks[0]
    return world && handVector(world)
  }
}

// Carrega cada modelo uma vez só; se falhar, deixa tentar de novo.
export async function detect(mode: Task, img: Source): Promise<number[] | undefined> {
  loaded[mode] ??= load(mode).catch((e) => {
    delete loaded[mode]
    throw e
  })
  return (await loaded[mode])(img)
}
