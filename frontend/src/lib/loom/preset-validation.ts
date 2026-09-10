import type { Preset } from '@/types/api'
import type { LoomPreset } from './types'
import { unmarshalPreset } from './service'
import {
  DEFAULT_ADVANCED_SETTINGS,
  DEFAULT_COMPLETION_SETTINGS,
  DEFAULT_CUSTOM_BODY,
  DEFAULT_PROMPT_BEHAVIOR,
  DEFAULT_SAMPLER_OVERRIDES,
} from './constants'

export class InvalidLoomPresetError extends Error {
  constructor(detail: string) {
    super(`Invalid Loom preset: ${detail}`)
    this.name = 'InvalidLoomPresetError'
  }
}

function check(condition: boolean, path: string): asserts condition {
  if (!condition) throw new InvalidLoomPresetError(path)
}

function record(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function settings(value: unknown, defaults: object, path: string): void {
  check(record(value), path)
  for (const [key, fallback] of Object.entries(defaults)) {
    const item = value[key]
    check(
      fallback === null
        ? item === null || (typeof item === 'number' && Number.isFinite(item))
        : Array.isArray(fallback)
          ? strings(item)
          : typeof item === typeof fallback && (typeof item !== 'number' || Number.isFinite(item)),
      `${path}.${key}`,
    )
  }
}

/** Validate renderable shapes, without rejecting legacy duplicate identities or extension metadata. */
export function assertRenderableLoomPreset(preset: LoomPreset): void {
  check(record(preset), 'preset')
  for (const key of ['id', 'name', 'description'] as const) {
    check(typeof preset[key] === 'string', key)
  }
  for (const key of ['coverUrl', 'presetVersion'] as const) {
    check(preset[key] === null || typeof preset[key] === 'string', key)
  }
  check(Array.isArray(preset.blocks), 'blocks')
  for (const block of preset.blocks) {
    check(record(block), 'block')
    for (const key of ['id', 'name', 'content', 'role', 'position'] as const) {
      check(typeof block[key] === 'string', `block.${key}`)
    }
    for (const key of ['marker', 'color', 'group'] as const) {
      check(block[key] == null || typeof block[key] === 'string', `block.${key}`)
    }
    check(strings(block.injectionTrigger), 'block.injectionTrigger')
    check(block.characterTagTrigger === undefined || strings(block.characterTagTrigger), 'block.characterTagTrigger')
    if (block.variables !== undefined) {
      check(Array.isArray(block.variables), 'block.variables')
      for (const variable of block.variables) {
        check(record(variable), 'variable')
        // Empty/duplicate legacy identities are editable; they are not render failures.
        for (const key of ['id', 'name', 'label', 'description'] as const) {
          check(variable[key] === undefined || typeof variable[key] === 'string', `variable.${key}`)
        }
        check(typeof variable.name === 'string' && typeof variable.label === 'string', 'variable.name/label')
        for (const key of ['min', 'max', 'step', 'rows'] as const) {
          check(variable[key] === undefined || (typeof variable[key] === 'number' && Number.isFinite(variable[key])), `variable.${key}`)
        }
        check(['text', 'textarea', 'number', 'slider', 'select', 'switch', 'multiselect'].includes(variable.type), 'variable.type')
        if (variable.type === 'select' || variable.type === 'multiselect') {
          check(Array.isArray(variable.options), 'variable.options')
          for (const option of variable.options) {
            check(record(option), 'variable.option')
            for (const key of ['id', 'label', 'value'] as const) {
              check(typeof option[key] === 'string', `variable.option.${key}`)
            }
          }
        }
        check(
          variable.type === 'multiselect'
            ? strings(variable.defaultValue)
            : typeof variable.defaultValue === (['number', 'slider', 'switch'].includes(variable.type) ? 'number' : 'string'),
          'variable.defaultValue',
        )
      }
    }
    if (block.placementBinding !== undefined) {
      check(record(block.placementBinding) && typeof block.placementBinding.variableId === 'string' && record(block.placementBinding.options), 'block.placementBinding')
      for (const placement of Object.values(block.placementBinding.options)) {
        check(record(placement) && typeof placement.role === 'string' && typeof placement.position === 'string' && typeof placement.depth === 'number', 'block.placementBinding.option')
      }
    }
  }
  settings(preset.samplerOverrides, DEFAULT_SAMPLER_OVERRIDES, 'samplerOverrides')
  settings(preset.customBody, DEFAULT_CUSTOM_BODY, 'customBody')
  settings(preset.promptBehavior, DEFAULT_PROMPT_BEHAVIOR, 'promptBehavior')
  settings(preset.completionSettings, DEFAULT_COMPLETION_SETTINGS, 'completionSettings')
  settings(preset.advancedSettings, DEFAULT_ADVANCED_SETTINGS, 'advancedSettings')
  check(record(preset.modelProfiles), 'modelProfiles')
  check(record(preset.promptVariables), 'promptVariables')
  for (const bucket of Object.values(preset.promptVariables)) {
    check(record(bucket), 'promptVariables.block')
    for (const value of Object.values(bucket)) {
      check(typeof value === 'string' || typeof value === 'number' || strings(value), 'promptVariables.value')
    }
  }
}

/** Treat malformed API data separately from transport failures so only corrupt selections recover. */
export function unmarshalPresetForEditor(preset: Preset): LoomPreset {
  try {
    check(record(preset), 'preset')
    for (const key of ['parameters', 'prompts', 'metadata'] as const) {
      check(preset[key] == null || record(preset[key]), key)
    }
    check(preset.prompt_order == null || Array.isArray(preset.prompt_order), 'prompt_order')
    const loom = unmarshalPreset(preset)
    assertRenderableLoomPreset(loom)
    return loom
  } catch (error) {
    if (error instanceof InvalidLoomPresetError) throw error
    throw new InvalidLoomPresetError(error instanceof Error ? error.message : 'unreadable data')
  }
}
