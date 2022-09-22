import {
  Client,
  CommandInteraction,
  GuildMember,
  Message,
  TextChannel,
} from 'discord.js'
import path from 'path'

import getAllFiles from '../util/get-all-files'
import Command from './Command'
import SlashCommands from './SlashCommands'
import { cooldownTypes } from '../util/Cooldowns'
import ChannelCommands from './ChannelCommands'
import CustomCommands from './CustomCommands'
import DisabledCommands from './DisabledCommands'
import PrefixHandler from './PrefixHandler'
import WOKCommands, {
  CommandUsage,
  InternalCooldownConfig,
} from '../../typings'
import { CommandType } from '..'

class CommandHandler {
  // <commandName, instance of the Command class>
  private _commands: Map<string, Command> = new Map()
  private _validations = this.getValidations(
    path.join(__dirname, 'validations', 'runtime')
  )
  private _channelCommands = new ChannelCommands()
  private _customCommands = new CustomCommands(this)
  private _disabledCommands = new DisabledCommands()
  private _prefixes = new PrefixHandler()
  private _instance: WOKCommands
  private _commandsDir: string
  private _slashCommands: SlashCommands
  private _client: Client

  constructor(instance: WOKCommands, commandsDir: string, client: Client) {
    this._instance = instance
    this._commandsDir = commandsDir
    this._slashCommands = new SlashCommands(client)
    this._client = client

    this._validations = [
      ...this._validations,
      ...this.getValidations(instance.validations?.runtime),
    ]

    this.readFiles()
  }

  public get commands() {
    return this._commands
  }

  public get channelCommands() {
    return this._channelCommands
  }

  public get slashCommands() {
    return this._slashCommands
  }

  public get customCommands() {
    return this._customCommands
  }

  public get disabledCommands() {
    return this._disabledCommands
  }

  public get prefixHandler() {
    return this._prefixes
  }

  private async readFiles() {
    const defaultCommands = getAllFiles(path.join(__dirname, './commands'))
    const files = getAllFiles(this._commandsDir)
    const validations = [
      ...this.getValidations(path.join(__dirname, 'validations', 'syntax')),
      ...this.getValidations(this._instance.validations?.syntax),
    ]

    for (let fileData of [...defaultCommands, ...files]) {
      const { filePath, fileContents: commandObject } = fileData

      const split = filePath.split(/[\/\\]/)
      let commandName = split.pop()!
      commandName = commandName.split('.')[0]

      const command = new Command(this._instance, commandName, commandObject)

      const {
        description,
        type,
        testOnly,
        delete: del,
        aliases = [],
        init = () => {},
      } = commandObject

      if (
        del ||
        this._instance.disabledDefaultCommands.includes(
          commandName.toLowerCase()
        )
      ) {
        if (type === 'SLASH' || type === 'BOTH') {
          if (testOnly) {
            for (const guildId of this._instance.testServers) {
              this._slashCommands.delete(command.commandName, guildId)
            }
          } else {
            this._slashCommands.delete(command.commandName)
          }
        }

        return
      }

      for (const validation of validations) {
        validation(command)
      }

      await init(this._client, this._instance)

      const names = [command.commandName, ...aliases]

      for (const name of names) {
        this._commands.set(name, command)
      }

      if (type === 'SLASH' || type === 'BOTH') {
        const options =
          commandObject.options ||
          this._slashCommands.createOptions(commandObject)

        if (testOnly) {
          for (const guildId of this._instance.testServers) {
            this._slashCommands.create(
              command.commandName,
              description,
              options,
              guildId
            )
          }
        } else {
          this._slashCommands.create(command.commandName, description, options)
        }
      }
    }
  }

  public async runCommand(
    command: Command,
    args: string[],
    message: Message | null,
    interaction: CommandInteraction | null
  ) {
    const { callback, type, cooldowns } = command.commandObject

    if (message && type === CommandType.SLASH) {
      return
    }

    const guild = message ? message.guild : interaction?.guild
    const member = (
      message ? message.member : interaction?.member
    ) as GuildMember
    const user = message ? message.author : interaction?.user
    const channel = (
      message ? message.channel : interaction?.channel
    ) as TextChannel

    const usage: CommandUsage = {
      instance: command.instance,
      message,
      interaction,
      args,
      text: args.join(' '),
      guild,
      member,
      user: user!,
      channel,
    }

    for (const validation of this._validations) {
      if (!(await validation(command, usage, this._prefixes.get(guild?.id)))) {
        return
      }
    }

    if (cooldowns) {
      let cooldownType: string = ''

      for (const type of cooldownTypes) {
        if (cooldowns[type]) {
          cooldownType = type
          break
        }
      }

      if (!cooldownType) {
        throw new Error(`Unknown cooldown type "${cooldownType}"`)
      }

      const cooldownUsage: InternalCooldownConfig = {
        cooldownType,
        userId: user!.id,
        actionId: `command_${command.commandName}`,
        guildId: guild?.id,
        duration: cooldowns[cooldownType],
        errorMessage: cooldowns.errorMessage,
      }

      const result = this._instance.cooldowns?.canRunAction(cooldownUsage)

      if (typeof result === 'string') {
        return result
      }

      await this._instance.cooldowns?.start(cooldownUsage)

      usage.cancelCooldown = () => {
        this._instance.cooldowns?.cancelCooldown(cooldownUsage)
      }

      usage.updateCooldown = (expires: Date) => {
        this._instance.cooldowns?.updateCooldown(cooldownUsage, expires)
      }
    }

    return await callback(usage)
  }

  private getValidations(folder?: string) {
    if (!folder) {
      return []
    }

    return getAllFiles(folder).map((fileData) => fileData.fileContents)
  }
}

export default CommandHandler