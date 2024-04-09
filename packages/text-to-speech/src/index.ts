/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unused-vars */

import { File, Storage } from '@google-cloud/storage'
import * as Sentry from '@sentry/serverless'
import axios from 'axios'
import crypto from 'crypto'
import * as dotenv from 'dotenv' // see https://github.com/motdotla/dotenv#how-do-i-use-dotenv-with-import
import Redis from 'ioredis'
import * as jwt from 'jsonwebtoken'
import { AzureTextToSpeech } from './azureTextToSpeech'
import { endSsml, htmlToSpeechFile, startSsml } from './htmlToSsml'
import { OpenAITextToSpeech } from './openaiTextToSpeech'
import { RealisticTextToSpeech } from './realisticTextToSpeech'
import { createRedisClient } from './redis'
import {
  SpeechMark,
  TextToSpeechInput,
  TextToSpeechOutput,
} from './textToSpeech'

interface UtteranceInput {
  text: string
  idx: string
  isUltraRealisticVoice?: boolean
  voice?: string
  rate?: string
  language?: string
}

interface HTMLInput {
  id: string
  text: string
  voice?: string
  language?: string
  rate?: string
  complimentaryVoice?: string
  bucket: string
}

interface CacheResult {
  audioDataString: string
  speechMarks: SpeechMark[]
}

interface Claim {
  uid: string
  featureName: string | null
  grantedAt: number | null
}

dotenv.config()
Sentry.GCPFunction.init({
  dsn: process.env.SENTRY_DSN,
  tracesSampleRate: 0,
})

const MAX_CHARACTER_COUNT = 50000
const storage = new Storage()

const textToSpeechHandlers = [
  new OpenAITextToSpeech(),
  new AzureTextToSpeech(),
  new RealisticTextToSpeech(),
]

const synthesizeTextToSpeech = async (
  input: TextToSpeechInput
): Promise<TextToSpeechOutput> => {
  const textToSpeechHandler = textToSpeechHandlers.find((handler) =>
    handler.use(input)
  )
  if (!textToSpeechHandler) {
    throw new Error('No text to speech handler found')
  }
  return textToSpeechHandler.synthesizeTextToSpeech(input)
}

const uploadToBucket = async (
  filePath: string,
  data: Buffer,
  bucket: string,
  options?: { contentType?: string; public?: boolean }
): Promise<void> => {
  await storage.bucket(bucket).file(filePath).save(data, options)
}

export const createGCSFile = (bucket: string, filename: string): File => {
  return storage.bucket(bucket).file(filename)
}

const updateSpeech = async (
  speechId: string,
  token: string,
  state: 'COMPLETED' | 'FAILED',
  audioFileName?: string,
  speechMarksFileName?: string
): Promise<boolean> => {
  if (!process.env.REST_BACKEND_ENDPOINT) {
    throw new Error('backend rest api endpoint not exists')
  }
  const response = await axios.post(
    `${process.env.REST_BACKEND_ENDPOINT}/text-to-speech?token=${token}`,
    {
      speechId,
      audioFileName,
      speechMarksFileName,
      state,
    }
  )

  return response.status === 200
}

const getCharacterCountFromRedis = async (
  redisClient: Redis,
  uid: string
): Promise<number> => {
  const wordCount = await redisClient.get(`tts:charCount:${uid}`)
  return wordCount ? parseInt(wordCount) : 0
}

// store character count of each text to speech request in redis
// which will be used to rate limit the request
// expires after 1 day
const updateCharacterCountInRedis = async (
  redisClient: Redis,
  uid: string,
  wordCount: number
) => {
  await redisClient.set(
    `tts:charCount:${uid}`,
    wordCount.toString(),
    'EX',
    86400, // 1 day in seconds
    'NX'
  )
}

export const textToSpeechHandler = Sentry.GCPFunction.wrapHttpFunction(
  async (req, res) => {
    console.info('Text to speech request body:', req.body)
    if (!process.env.JWT_SECRET) {
      console.error('JWT_SECRET not exists')
      return res.status(500).send({ errorCodes: 'JWT_SECRET_NOT_EXISTS' })
    }

    const token = (req.query.token || req.headers.authorization) as string
    if (!token) {
      return res.status(401).send({ errorCode: 'INVALID_TOKEN' })
    }

    try {
      jwt.verify(token, process.env.JWT_SECRET)
    } catch (e) {
      console.error('Authentication error:', e)
      return res.status(200).send('UNAUTHENTICATED')
    }
    // validate input
    const input = req.body as HTMLInput
    const id = input.id
    const bucket = input.bucket
    if (!id || !bucket) {
      return res.status(200).send('INVALID_INPUT')
    }
    try {
      // audio file to be saved in GCS
      const audioFileName = `speech/${id}.mp3`
      const audioFile = createGCSFile(bucket, audioFileName)
      const audioStream = audioFile.createWriteStream({
        resumable: true,
      }) as NodeJS.WriteStream
      // synthesize text to speech
      const startTime = Date.now()
      // temporary solution to use realistic text to speech
      const { speechMarks } = await synthesizeTextToSpeech({
        ...input,
        textType: 'html',
        audioStream,
        key: id,
      })
      console.info(
        `Synthesize text to speech completed in ${Date.now() - startTime} ms`
      )

      // speech marks file to be saved in GCS
      let speechMarksFileName: string | undefined
      if (speechMarks.length > 0) {
        speechMarksFileName = `speech/${id}.json`
        await uploadToBucket(
          speechMarksFileName,
          Buffer.from(JSON.stringify(speechMarks)),
          bucket
        )
      }

      // update speech state
      const updated = await updateSpeech(
        id,
        token,
        'COMPLETED',
        audioFileName,
        speechMarksFileName
      )
      if (!updated) {
        console.error('Failed to update speech')
        return res.status(500).send({ errorCodes: 'DB_ERROR' })
      }
      console.info('Text to speech cloud function completed')
      res.send('OK')
    } catch (e) {
      console.error('Text to speech cloud function error:', e)
      await updateSpeech(id, token, 'FAILED')
      return res.status(500).send({ errorCodes: 'SYNTHESIZER_ERROR' })
    }
  }
)

export const textToSpeechStreamingHandler = Sentry.GCPFunction.wrapHttpFunction(
  async (req, res) => {
    console.log('Text to speech steaming request body:', req.body)
    if (!process.env.JWT_SECRET) {
      console.error('JWT_SECRET not exists')
      return res.status(500).send({ errorCodes: 'JWT_SECRET_NOT_EXISTS' })
    }
    const token = (req.query.token || req.headers.authorization) as string
    if (!token) {
      return res.status(401).send({ errorCode: 'INVALID_TOKEN' })
    }

    let claim: Claim
    try {
      claim = jwt.verify(token, process.env.JWT_SECRET, {
        ignoreExpiration: true,
      }) as Claim
    } catch (e) {
      console.error('Authentication error:', e)
      return res.status(401).send({ errorCode: 'UNAUTHENTICATED' })
    }

    // create redis client
    const redisClient = createRedisClient(
      process.env.REDIS_TTS_URL,
      process.env.REDIS_TTS_CERT
    )

    try {
      const utteranceInput = req.body as UtteranceInput
      if (!utteranceInput.text) {
        return res.send({
          idx: utteranceInput.idx,
          audioData: '',
          speechMarks: [],
        })
      }

      // validate if user has opted in to use ultra realistic voice feature
      if (
        utteranceInput.isUltraRealisticVoice &&
        (claim.featureName !== 'ultra-realistic-voice' || !claim.grantedAt)
      ) {
        return res.status(403).send('UNAUTHORIZED')
      }

      // validate character count
      const characterCount =
        (await getCharacterCountFromRedis(redisClient, claim.uid)) +
        utteranceInput.text.length
      if (characterCount > MAX_CHARACTER_COUNT) {
        return res.status(429).send('RATE_LIMITED')
      }

      const ssmlOptions = {
        primaryVoice: utteranceInput.voice,
        secondaryVoice: utteranceInput.voice,
        language: utteranceInput.language,
        rate: utteranceInput.rate,
      }
      // for utterance, assemble the ssml and pass it through
      const ssml = `${startSsml(ssmlOptions)}${utteranceInput.text}${endSsml()}`
      // hash ssml to get the cache key
      const cacheKey = crypto.createHash('md5').update(ssml).digest('hex')
      // find audio data in cache
      const cacheResult = await redisClient.get(cacheKey)
      if (cacheResult) {
        console.log('Cache hit')
        const { audioDataString, speechMarks }: CacheResult =
          JSON.parse(cacheResult)
        res.send({
          idx: utteranceInput.idx,
          audioData: audioDataString,
          speechMarks,
        })
        return
      }
      console.log('Cache miss')

      const bucket = process.env.GCS_UPLOAD_BUCKET
      if (!bucket) {
        throw new Error('GCS_UPLOAD_BUCKET not set')
      }

      // audio file to be saved in GCS
      const audioFileName = `speech/${cacheKey}.mp3`
      const speechMarksFileName = `speech/${cacheKey}.json`
      const audioFile = createGCSFile(bucket, audioFileName)
      const speechMarksFile = createGCSFile(bucket, speechMarksFileName)

      let audioData: Buffer | undefined
      let speechMarks: SpeechMark[] = []
      // check if audio file already exists
      const [exists] = await audioFile.exists()
      if (exists) {
        console.debug('Audio file already exists')
        ;[audioData] = await audioFile.download()
        const [speechMarksExists] = await speechMarksFile.exists()
        if (speechMarksExists) {
          speechMarks = JSON.parse(
            (await speechMarksFile.download()).toString()
          )
        }
      } else {
        // audio file does not exist, synthesize text to speech
        const input: TextToSpeechInput = {
          ...utteranceInput,
          textType: 'ssml',
          key: cacheKey,
        }
        // synthesize text to speech if cache miss
        const output = await synthesizeTextToSpeech(input)
        audioData = output.audioData
        speechMarks = output.speechMarks
        if (!audioData || audioData.length === 0) {
          return res.send({
            idx: utteranceInput.idx,
            audioData: '',
            speechMarks: [],
          })
        }

        console.debug('saving audio file')
        // upload audio data to GCS
        await audioFile.save(audioData)
        // upload speech marks to GCS
        if (speechMarks.length > 0) {
          await speechMarksFile.save(JSON.stringify(speechMarks))
        }
      }

      const audioDataString = audioData.toString('hex')
      // save audio data to cache for 72 hours for mainly the newsletters
      await redisClient.set(
        cacheKey,
        JSON.stringify({ audioDataString, speechMarks }),
        'EX',
        3600 * 72,
        'NX'
      )
      console.log('Cache saved')

      // update character count
      await updateCharacterCountInRedis(redisClient, claim.uid, characterCount)

      res.send({
        idx: utteranceInput.idx,
        audioData: audioDataString,
        speechMarks,
      })
    } catch (e) {
      console.error('Text to speech streaming error:', e)
      return res.status(500).send({ errorCodes: 'SYNTHESIZER_ERROR' })
    } finally {
      await redisClient.quit()
      console.log('Redis Client Disconnected')
    }
  }
)

module.exports = {
  htmlToSpeechFile,
  textToSpeechStreamingHandler,
  textToSpeechHandler,
}
