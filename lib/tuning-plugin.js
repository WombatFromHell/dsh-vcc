// Patch-addressable home for dsh-vcc's compaction defaults.
//
// A patch file cannot override a plugin nested inside a preset: `loader.resolve()` does not
// address nested ids (`preset-ptc:dsh-vcc` is rejected) and restating a preset row replaces that
// preset's whole `config`. Declaring this entry at host level makes the numbers addressable by id,
// so an override is a few lines in cordis.patch.yml instead of a per-route YAML table, and every
// preset picks it up because the engine injects it — host-level inject already crosses the preset
// boundary (the base engine injects `llm`/`tokenMeter`/`sessions` while mounted in a preset group).
//
// A preset row that declares its own `dsh-vcc` config still wins over these defaults: that is how
// per-preset tuning is expressed.
import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { DEFAULTS } from './tuning.js'

/** Compaction defaults. Every key has a default, so an empty row is a valid override. */
export default class DshVccTuning extends Service {
  static Config = z.object({
    thresholdRatio: z.number().min(0).max(1).default(DEFAULTS.thresholdRatio),
    retainTokens: z.number().step(1).min(0).default(DEFAULTS.retainTokens),
    headroomTokens: z.number().step(1).min(0).default(DEFAULTS.headroomTokens),
    auto: z.boolean().default(true),
  })

  /** Validated knobs, with DEFAULTS backfilled for anything an older entry does not declare. */
  config
  constructor(ctx, config = {}) {
    super(ctx, 'dsh-vcc-tuning')
    this.config = Object.freeze({ ...DEFAULTS, ...config })
  }
}
