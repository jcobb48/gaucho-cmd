
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Client as DiscordClient,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChatInputCommandInteraction,
} from 'discord.js';
import { execFile } from 'node:child_process';


@Injectable()
export class DiscordBotService implements OnModuleInit {
  private readonly log = new Logger(DiscordBotService.name);
  private client: DiscordClient;
  private rest: REST;
  private allowedRole?: string;
  private allowedUser?: string;
  private serviceName: string;

  constructor(private cfg: ConfigService) {
    this.client = new DiscordClient({ intents: [GatewayIntentBits.Guilds] });
    this.rest = new REST({ version: '10' }).setToken(
      this.cfg.get<string>('DISCORD_TOKEN')!,
    );
    this.allowedRole = this.cfg.get<string>('ALLOWED_ROLE_ID') || undefined;
    this.allowedUser = this.cfg.get<string>('ALLOWED_USER_ID') || undefined;
    this.serviceName = this.cfg.get<string>('RESET_SERVICE', '').trim();
    if (!this.serviceName) {
      throw new Error('RESET_SERVICE not set');
    }
  }

  async onModuleInit() {
    await this.registerSlash();
    this.wireEvents();
    await this.client.login(this.cfg.get<string>('DISCORD_TOKEN'));
  }

  private async registerSlash() {
    const cmd = new SlashCommandBuilder()
      .setName('reset')
      .setDescription('Restart the target systemd service locally');

    await this.rest.put(
      Routes.applicationGuildCommands(
        this.cfg.get<string>('DISCORD_APP_ID')!,
        this.cfg.get<string>('DISCORD_GUILD_ID')!,
      ),
      { body: [cmd.toJSON()] },
    );
    this.log.log('Slash command upserted');
  }

  private wireEvents() {
    this.client.once('ready', () =>
      this.log.log(`Logged in as ${this.client.user?.tag}`),
    );

    this.client.on('interactionCreate', async (i) => {
      this.log.debug(`Cmd received: ${i.isCommand}`)
      if (!i.isChatInputCommand()) return;
      if (i.commandName === 'reset') await this.handleReset(i);
    });
  }

  private async handleReset(i: ChatInputCommandInteraction) {
    if (!this.isAllowed(i)) {
      await i.reply({ content: 'Not authorized.', ephemeral: true });
      return;
    }

    await i.deferReply({ ephemeral: true });
    try {
      const { code, stdout, stderr } = await this.restartService();
      if (code === 0) {
        await i.editReply('Restart requested. Exit code 0.');
      } else {
        const out = (stderr || stdout || 'no output').slice(0, 1900);
        await i.editReply(`Restart failed. code=${code}\n${out}`);
      }
    } catch (e: any) {
      await i.editReply(`Exec error: ${e.message}`.slice(0, 1900));
    }
  }

  private isAllowed(i: ChatInputCommandInteraction): boolean {
    if (this.allowedUser && i.user.id === this.allowedUser) return true;
    if (this.allowedRole && i.member && 'roles' in i.member) {
      // @ts-ignore discord.js member typing
      if (i.member.roles?.cache?.has?.(this.allowedRole)) return true;
    }
    return i.memberPermissions?.has(PermissionFlagsBits.Administrator) || false;
  }

  private restartService(): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const child = execFile(
        'sudo',
        ['systemctl', 'restart', this.serviceName],
        { timeout: 30_000 },
        (err, stdout, stderr) => {
          if (err) {
            const anyErr = err as any;
            resolve({
              code: Number.isInteger(anyErr.code) ? anyErr.code : 1,
              stdout: stdout?.toString() || '',
              stderr: stderr?.toString() || String(err),
            });
          } else {
            resolve({ code: 0, stdout: stdout?.toString() || '', stderr: '' });
          }
        },
      );
      child.on('error', (e) =>
        resolve({ code: 1, stdout: '', stderr: String(e) }),
      );
    });
  }
}
