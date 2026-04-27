// src/main/ai-config.js
// Loads and saves AI provider settings from app.getPath('userData')/ai-config.json
// API keys are encrypted at rest using Electron's safeStorage API.
const fs = require('fs')
const path = require('path')
const { app, safeStorage } = require('electron')

const CONFIG_PATH = path.join(app.getPath('userData'), 'ai-config.json')

// Prefix marker to distinguish encrypted keys from legacy plaintext
const ENC_PREFIX = 'enc:'

const DEFAULT_CONFIG = {
  provider: 'ollama',       // 'ollama' | 'openai-compatible' | 'hermes'
  baseURL: 'http://localhost:11434/v1',
  apiKey: '',
  model: 'ministral-3:3b',
  temperature: 0.7,
  maxTokens: 2048,
  enabled: true
}

/**
 * Encrypt an API key for storage. Returns 'enc:' + base64 string.
 * If safeStorage is unavailable (e.g. during tests), returns plaintext.
 */
function encryptKey(plainText) {
  if (!plainText) return ''
  if (!safeStorage.isEncryptionAvailable()) return plainText
  const encrypted = safeStorage.encryptString(plainText)
  return ENC_PREFIX + encrypted.toString('base64')
}

/**
 * Decrypt an API key from storage. Handles both encrypted ('enc:' + base64)
 * and legacy plaintext keys for migration.
 */
function decryptKey(stored) {
  if (!stored) return ''
  // Legacy plaintext key — return as-is (will be re-encrypted on next save)
  if (!stored.startsWith(ENC_PREFIX)) return stored
  if (!safeStorage.isEncryptionAvailable()) {
    // Can't decrypt without safeStorage — this shouldn't happen in production
    console.error('[Gabo AI] Cannot decrypt API key: safeStorage unavailable')
    return ''
  }
  const buf = Buffer.from(stored.slice(ENC_PREFIX.length), 'base64')
  return safeStorage.decryptString(buf)
}

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'))
      const config = { ...DEFAULT_CONFIG, ...raw }
      // Decrypt apiKey for in-memory use
      config.apiKey = decryptKey(config.apiKey)
      return config
    }
  } catch (e) {
    console.error('[Gabo AI] Failed to load config:', e)
  }
  return { ...DEFAULT_CONFIG }
}

function saveConfig(config) {
  // Encrypt apiKey for disk storage, but keep the in-memory config unchanged
  const toSave = { ...config }
  if (toSave.apiKey) {
    toSave.apiKey = encryptKey(toSave.apiKey)
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(toSave, null, 2), 'utf-8')
}

function validateConfig(config) {
  const errors = []
  const clean = { ...DEFAULT_CONFIG, ...config }

  // baseURL must be a valid http(s) URL
  try {
    const u = new URL(clean.baseURL)
    if (!['http:', 'https:'].includes(u.protocol)) throw new Error()
    clean.baseURL = u.toString().replace(/\/+$/, '')
  } catch {
    errors.push('baseURL must be a valid http(s) URL')
  }

  // temperature: 0–2
  clean.temperature = Number(clean.temperature)
  if (isNaN(clean.temperature) || clean.temperature < 0 || clean.temperature > 2) {
    errors.push('temperature must be between 0 and 2')
    clean.temperature = DEFAULT_CONFIG.temperature
  }

  // maxTokens: 1–32768
  clean.maxTokens = Number(clean.maxTokens)
  if (isNaN(clean.maxTokens) || clean.maxTokens < 1 || clean.maxTokens > 32768) {
    errors.push('maxTokens must be between 1 and 32768')
    clean.maxTokens = DEFAULT_CONFIG.maxTokens
  }

  // model: non-empty string
  if (typeof clean.model !== 'string' || clean.model.trim() === '') {
    errors.push('model must be a non-empty string')
    clean.model = DEFAULT_CONFIG.model
  }

  return { clean, errors }
}

module.exports = { loadConfig, saveConfig, validateConfig, CONFIG_PATH, DEFAULT_CONFIG }