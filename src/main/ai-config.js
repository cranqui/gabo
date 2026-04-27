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

module.exports = { loadConfig, saveConfig, CONFIG_PATH, DEFAULT_CONFIG }