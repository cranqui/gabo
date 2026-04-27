// src/main/ai-config.js
// Loads and saves AI provider settings from app.getPath('userData')/ai-config.json
const fs = require('fs')
const path = require('path')
const { app } = require('electron')

const CONFIG_PATH = path.join(app.getPath('userData'), 'ai-config.json')

const DEFAULT_CONFIG = {
  provider: 'ollama',       // 'ollama' | 'openai-compatible' | 'hermes'
  baseURL: 'http://localhost:11434/v1',
  apiKey: '',
  model: 'ministral-3:3b',
  temperature: 0.7,
  maxTokens: 2048,
  enabled: true
}

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) }
    }
  } catch (e) {
    console.error('[Gabo AI] Failed to load config:', e)
  }
  return { ...DEFAULT_CONFIG }
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8')
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