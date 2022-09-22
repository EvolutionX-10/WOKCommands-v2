import cooldownSchema from '../models/cooldown-schema'
import WOKCommands, {
  CooldownConfig,
  InternalCooldownConfig,
} from '../../typings'

const cooldownDurations = {
  s: 1,
  m: 60,
  h: 60 * 60,
  d: 60 * 60 * 24,
} as { [key: string]: number }

export const cooldownTypes = [
  'perUser',
  'perUserPerGuild',
  'perGuild',
  'global',
]

class Cooldowns {
  // perUser:
  // <`${userId}-${actionId}`: expires>
  // perUsePerGuild:
  // <`${userId}-${guildId}-${actionId}`: expires>
  // perGuild:
  // <`${guildId}-${actionId}`: expires>
  // global:
  // <action: expires>
  private _cooldowns = new Map()
  private _instance: WOKCommands
  private _errorMessage: string
  private _botOwnersBypass: boolean
  private _dbRequired: number

  constructor(instance: WOKCommands, cooldownConfig: CooldownConfig) {
    const {
      errorMessage = 'Please wait {TIME} before doing that again.',
      botOwnersBypass = false,
      dbRequired = 300, // 5 minutes
    } = cooldownConfig

    this._instance = instance
    this._errorMessage = errorMessage
    this._botOwnersBypass = botOwnersBypass
    this._dbRequired = dbRequired

    this.loadCooldowns()
  }

  private async loadCooldowns() {
    await cooldownSchema.deleteMany({
      expires: { $lt: new Date() },
    })

    const results = await cooldownSchema.find({})

    for (const result of results) {
      const { _id, expires } = result

      this._cooldowns.set(_id, expires)
    }
  }

  public getKeyFromCooldownUsage(cooldownUsage: InternalCooldownConfig) {
    const { cooldownType, userId, actionId, guildId } = cooldownUsage

    return this.getKey(cooldownType, userId, actionId, guildId)
  }

  public async cancelCooldown(cooldownUsage: InternalCooldownConfig) {
    const key = this.getKeyFromCooldownUsage(cooldownUsage)

    this._cooldowns.delete(key)

    await cooldownSchema.deleteOne({ _id: key })
  }

  public async updateCooldown(
    cooldownUsage: InternalCooldownConfig,
    expires: Date
  ) {
    const key = this.getKeyFromCooldownUsage(cooldownUsage)

    this._cooldowns.set(key, expires)

    const now = new Date()
    const secondsDiff = (expires.getTime() - now.getTime()) / 1000

    if (secondsDiff > this._dbRequired) {
      await cooldownSchema.findOneAndUpdate(
        {
          _id: key,
        },
        {
          _id: key,
          expires,
        },
        {
          upsert: true,
        }
      )
    }
  }

  public verifyCooldown(duration: number | string) {
    if (typeof duration === 'number') {
      return duration
    }

    const split = duration.split(' ')

    if (split.length !== 2) {
      throw new Error(
        `Duration "${duration}" is an invalid duration. Please use "10 m", "15 s" etc.`
      )
    }

    const quantity = +split[0]
    const type = split[1].toLowerCase()

    if (!cooldownDurations[type]) {
      throw new Error(
        `Unknown duration type "${type}". Please use one of the following: ${Object.keys(
          cooldownDurations
        )}`
      )
    }

    if (quantity <= 0) {
      throw new Error(
        `Invalid quantity of "${quantity}". Please use a value greater than 0.`
      )
    }

    return quantity * cooldownDurations[type]
  }

  public getKey(
    cooldownType: string,
    userId: string,
    actionId: string,
    guildId?: string
  ) {
    const isPerUser = cooldownType === cooldownTypes[0]
    const isPerUserPerGuild = cooldownType === cooldownTypes[1]
    const isPerGuild = cooldownType === cooldownTypes[2]
    const isGlobal = cooldownType === cooldownTypes[3]

    if ((isPerUserPerGuild || isPerGuild) && !guildId) {
      throw new Error(
        `Invalid cooldown type "${cooldownType}" used outside of a guild.`
      )
    }

    if (isPerUser) {
      return `${userId}-${actionId}`
    }

    if (isPerUserPerGuild) {
      return `${userId}-${guildId}-${actionId}`
    }

    if (isPerGuild) {
      return `${guildId}-${actionId}`
    }

    if (isGlobal) {
      return actionId
    }
  }

  public canBypass(userId: string) {
    return this._botOwnersBypass && this._instance.botOwners.includes(userId)
  }

  public async start(cooldownUsage: InternalCooldownConfig) {
    const {
      cooldownType,
      userId,
      actionId,
      guildId = '',
      duration,
    } = cooldownUsage

    if (this.canBypass(userId)) {
      return
    }

    if (!cooldownTypes.includes(cooldownType)) {
      throw new Error(
        `Invalid cooldown type "${cooldownType}". Please use one of the following: ${cooldownTypes}`
      )
    }

    const seconds = this.verifyCooldown(duration!)

    const key = this.getKey(cooldownType, userId, actionId, guildId)

    const expires = new Date()
    expires.setSeconds(expires.getSeconds() + seconds)

    if (seconds >= this._dbRequired) {
      await cooldownSchema.findOneAndUpdate(
        {
          _id: key,
        },
        {
          _id: key,
          expires,
        },
        {
          upsert: true,
        }
      )
    }

    this._cooldowns.set(key, expires)
  }

  public canRunAction(cooldownUsage: InternalCooldownConfig) {
    const {
      cooldownType,
      userId,
      actionId,
      guildId = '',
      errorMessage = this._errorMessage,
    } = cooldownUsage

    if (this.canBypass(userId)) {
      return true
    }

    const key = this.getKey(cooldownType, userId, actionId, guildId)
    const expires = this._cooldowns.get(key)

    if (!expires) {
      return true
    }

    const now = new Date()
    if (now > expires) {
      this._cooldowns.delete(key)
      return true
    }

    const secondsDiff = (expires.getTime() - now.getTime()) / 1000
    const d = Math.floor(secondsDiff / (3600 * 24))
    const h = Math.floor((secondsDiff % (3600 * 24)) / 3600)
    const m = Math.floor((secondsDiff % 3600) / 60)
    const s = Math.floor(secondsDiff % 60)

    let time = ''
    if (d > 0) time += `${d}d `
    if (h > 0) time += `${h}h `
    if (m > 0) time += `${m}m `
    time += `${s}s`

    return errorMessage.replace('{TIME}', time)
  }
}

export default Cooldowns