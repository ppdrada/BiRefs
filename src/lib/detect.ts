// Roda o MediaPipe no navegador: a foto não sai do aparelho.
import { FaceLandmarker, HandLandmarker, PoseLandmarker } from '@mediapipe/tasks-vision'
import wasmLoaderPath from '@mediapipe/tasks-vision/vision_wasm_internal.js?url'
import wasmBinaryPath from '@mediapipe/tasks-vision/vision_wasm_internal.wasm?url'
import ortWasmPath from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url'
import * as ort from 'onnxruntime-web/wasm'
import { bodyVector, faceAngles, handVector, type Mode } from './features'

// Mesmos modelos de scripts/build_index.py.
// 'embed' = impressão de semelhança geral (qualquer imagem, não só pessoas): CLIP ViT-B/32 da OpenAI (licença MIT),
// que entende o assunto da imagem. Trocou o modelo? Mude EMBED_VERSION no script e refaça o índice.
export type Task = Mode | 'embed'

const MODELS: Record<Task, string> = {
  face: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
  body: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
  hand: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
  embed: 'https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/main/onnx/vision_model_q4f16.onnx',
}

type Source = HTMLImageElement | HTMLCanvasElement // canvas = foto com recorte, giro ou brilho aplicados

const fileset = { wasmLoaderPath, wasmBinaryPath }
type Result = number[] | undefined
const loaded: Partial<Record<Task, Promise<(img: Source) => Result | Promise<Result>>>> = {}

const CLIP_SIZE = 224
const CLIP_MEAN = [0.48145466, 0.4578275, 0.40821073]
const CLIP_STD = [0.26862954, 0.26130258, 0.27577711]

// Recorta o quadrado central, reduz para 224 px e normaliza. Espelha embed() em scripts/build_index.py.
function clipInput(img: Source): Float32Array {
  const [w, h] = 'naturalWidth' in img ? [img.naturalWidth, img.naturalHeight] : [img.width, img.height]
  const side = Math.min(w, h)
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = CLIP_SIZE
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(img, Math.floor((w - side) / 2), Math.floor((h - side) / 2), side, side, 0, 0, CLIP_SIZE, CLIP_SIZE)
  const { data } = ctx.getImageData(0, 0, CLIP_SIZE, CLIP_SIZE)
  const area = CLIP_SIZE * CLIP_SIZE
  const out = new Float32Array(3 * area) // um plano por cor: todos os vermelhos, depois verdes, depois azuis
  for (let i = 0; i < area; i++) {
    for (let c = 0; c < 3; c++) out[c * area + i] = (data[i * 4 + c] / 255 - CLIP_MEAN[c]) / CLIP_STD[c]
  }
  return out
}

async function load(mode: Task) {
  const baseOptions = { modelAssetPath: MODELS[mode], delegate: 'CPU' as const }
  if (mode === 'embed') {
    ort.env.wasm.wasmPaths = { wasm: ortWasmPath }
    ort.env.wasm.numThreads = 1 // mais de uma thread exigiria cabeçalhos especiais no servidor
    const session = await ort.InferenceSession.create(MODELS.embed, { executionProviders: ['wasm'] })
    return async (img: Source) => {
      const input = new ort.Tensor('float32', clipInput(img), [1, 3, CLIP_SIZE, CLIP_SIZE])
      return Array.from((await session.run({ pixel_values: input })).image_embeds.data as Float32Array)
    }
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
