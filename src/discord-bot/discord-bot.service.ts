import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ChatInputCommandInteraction,
  Client as DiscordClient,
  GatewayIntentBits,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
} from 'discord.js';
import { Client as SSHClient } from 'ssh2';

@Injectable()
export class DiscordBotService implements OnModuleInit {
  private readonly log = new Logger(DiscordBotService.name);
  private client: DiscordClient;
  private rest: REST;
  private allowedRole?: string;
  private allowedUser?: string;

  private req(name: string): string {
    const v = this.cfg.get<string>(name);
    if (!v || !String(v).trim()) throw new Error(`${name} not set`);
    return v;
  }

  constructor(private cfg: ConfigService) {
    this.client = new DiscordClient({ intents: [GatewayIntentBits.Guilds] });
    this.rest = new REST({ version: '10' }).setToken(this.req('DISCORD_TOKEN'));
    this.allowedRole = this.cfg.get<string>('ALLOWED_ROLE_ID') || undefined;
    this.allowedUser = this.cfg.get<string>('ALLOWED_USER_ID') || undefined;
  }

  async onModuleInit() {
    await this.registerSlashCommands();
    this.wireEvents();
    await this.client.login(this.req('DISCORD_TOKEN'));
  }

  private async registerSlashCommands() {
    const restartCmd = new SlashCommandBuilder()
      .setName('restart')
      .setDescription('Reinicia PZ Gaucho Server');
    const statusCmd = new SlashCommandBuilder()
      .setName('status')
      .setDescription('Devuelve el estado del server');
    const t = await this.rest.put(
      Routes.applicationGuildCommands(this.req('DISCORD_APP_ID'), this.req('DISCORD_GUILD_ID')),
      { body: [
          restartCmd.toJSON(),
          statusCmd.toJSON()
        ],
      },
    );
    this.log.log('SlashCommandsRegistered');
  }

  private wireEvents() {
    this.client.once('ready', () => this.log.log(`Logged in as ${this.client.user?.tag}`));
    this.client.on('interactionCreate', async (i) => {
      if (!i.isChatInputCommand()) return;
      if (i.commandName === 'restart') await this.handleRestart(i);
      if (i.commandName === 'status') await this.handleStatus(i);
    });
  }

  private async handleRestart(i: ChatInputCommandInteraction) {
    if (!this.isAllowed(i)) {
      await i.reply({ content: 'Not authorized.', ephemeral: true });
      return;
    }
    await i.deferReply({ ephemeral: true });

    try {
      const cmd = this.req('RESTART_CMD');
      const { code, stdout, stderr } = await this.runRemote(cmd);
      if (code === 0) {
        await i.editReply('Reinicio exitoso, ahora a esperar que se haga el backup...');
      } else {
        const out = (stderr || stdout || 'no output').slice(0, 1900);
        await i.editReply(`Restart command failed. code=${code}\n${out}`);
      }
    } catch (e: any) {
      await i.editReply(`Error: ${e.message}`.slice(0, 1900));
    }
  }

    private async handleStatus(i: ChatInputCommandInteraction) {
    if (!this.isAllowed(i)) {
      await i.reply({ content: 'Not authorized.', ephemeral: true });
      return;
    }
    await i.deferReply({ ephemeral: true });

    try {
      const cmd = this.req('STATUS_CMD');
      const { code, stdout, stderr } = await this.runRemote(cmd);
      if (code === 0) {
        await i.editReply(`Estado del server: ${stdout}`);
      } else {
        const out = (stderr || stdout || 'no output').slice(0, 1900);
        await i.editReply(`Status command failed. code=${code}\n${out}`);
      }
    } catch (e: any) {
      await i.editReply(`Error: ${e.message}`.slice(0, 1900));
    }
  }


  private isAllowed(i: ChatInputCommandInteraction): boolean {
    if (this.allowedUser && i.user.id === this.allowedUser) return true;
    if (this.allowedRole && i.member && 'roles' in i.member) {
      // @ts-ignore discord.js typing guard for GuildMember
      if (i.member.roles?.cache?.has?.(this.allowedRole)) return true;
    }
    return i.memberPermissions?.has(PermissionFlagsBits.Administrator) || false;
  }

  private runRemote(cmd: string): Promise<{ code: number; stdout: string; stderr: string }> {
    const host = this.req('SSH_HOST');
    const port = Number(this.cfg.get<string>('SSH_PORT') || 22);
    const username = this.req('SSH_USER');

    // Key from env: prefer base64, else literal with \n escapes, else password
    const keyB64 = this.cfg.get<string>('SSH_PRIVATE_KEY_B64');
    const keyRaw = this.cfg.get<string>('SSH_PRIVATE_KEY');
    const passphrase = this.cfg.get<string>('SSH_KEY_PASSPHRASE') || undefined;
    const password = this.cfg.get<string>('SSH_PASSWORD') || undefined;

    let privateKey: string | undefined;
    if (keyB64) privateKey = Buffer.from(keyB64, 'base64').toString('utf8');
    else if (keyRaw) privateKey = keyRaw.includes('\\n') ? keyRaw.replace(/\\n/g, '\n') : keyRaw;

    // Optional host key pinning
    const pinned = this.cfg.get<string>('SSH_HOST_FINGERPRINT') || ''; // e.g. "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI..."
    const hostVerifier = pinned
      ? (hash: string) => hash === pinned
      : undefined;

    const auth: any = { host, port, username, hostVerifier };
    if (privateKey) {
      auth.privateKey = privateKey;
      if (passphrase) auth.passphrase = passphrase;
    } else if (password) {
      auth.password = password;
    } else {
      throw new Error('No SSH credentials: set SSH_PRIVATE_KEY_B64 or SSH_PRIVATE_KEY or SSH_PASSWORD');
    }

    return new Promise((resolve, reject) => {
      const conn = new SSHClient();
      let stdout = '', stderr = '';
      conn
        .on('ready', () => {
          // Requires NOPASSWD for this exact command on the host.
          conn.exec(cmd, (err, stream) => {
            if (err) { conn.end(); return reject(err); }
            stream
              .on('close', (code: number | null) => {
                conn.end();
                resolve({ code: code ?? 0, stdout, stderr });
              })
              .on('data', (d: Buffer) => { stdout += d.toString(); })
              .stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
          });
        })
        .on('error', reject)
        .connect(auth);
    });
  }
}