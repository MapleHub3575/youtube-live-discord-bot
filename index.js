const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits
} = require("discord.js");

const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  StreamType
} = require("@discordjs/voice");

const { spawn } = require("child_process");

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error("กรุณาตั้ง DISCORD_TOKEN, CLIENT_ID และ GUILD_ID");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates
  ]
});

const players = new Map();

const commands = [
  new SlashCommandBuilder()
    .setName("join")
    .setDescription("ให้บอทเข้าห้องเสียงของคุณ"),

  new SlashCommandBuilder()
    .setName("playlive")
    .setDescription("เปิดเสียงจาก YouTube Live")
    .addStringOption(option =>
      option
        .setName("url")
        .setDescription("ลิงก์ YouTube Live")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("stop")
    .setDescription("หยุดเสียงไลฟ์"),

  new SlashCommandBuilder()
    .setName("leave")
    .setDescription("ให้บอทออกจากห้องเสียง")
].map(command => command.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);

  await rest.put(
    Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
    { body: commands }
  );

  console.log("ลงทะเบียน Slash Commands แล้ว");
}

function getVoiceChannel(interaction) {
  return interaction.member?.voice?.channel;
}

function stopPlayback(guildId) {
  const data = players.get(guildId);

  if (!data) return;

  try {
    data.player.stop();
  } catch {}

  if (data.ytdlp && !data.ytdlp.killed) {
    data.ytdlp.kill("SIGKILL");
  }

  if (data.ffmpeg && !data.ffmpeg.killed) {
    data.ffmpeg.kill("SIGKILL");
  }

  try {
    data.connection.destroy();
  } catch {}

  players.delete(guildId);
}

async function playLive(interaction, url) {
  const guildId = interaction.guildId;
  const channel = getVoiceChannel(interaction);

  if (!channel) {
    return interaction.reply({
      content: "❌ คุณต้องอยู่ในห้อง Voice ก่อน",
      ephemeral: true
    });
  }

  if (
    !url.includes("youtube.com/") &&
    !url.includes("youtu.be/")
  ) {
    return interaction.reply({
      content: "❌ ลิงก์นี้ไม่ใช่ลิงก์ YouTube",
      ephemeral: true
    });
  }

  await interaction.deferReply();

  stopPlayback(guildId);

  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: true
  });

  const player = createAudioPlayer();

  /*
   * yt-dlp:
   * ดึงเฉพาะ audio จาก YouTube Live
   *
   * -f bestaudio/best
   * เลือกเสียงที่ดีที่สุด
   *
   * -o -
   * ส่งข้อมูลออกทาง stdout
   */
  const ytdlp = spawn("yt-dlp", [
    "--no-playlist",
    "--no-warnings",
    "--quiet",
    "-f",
    "bestaudio/best",
    "-o",
    "-",
    url
  ]);

  /*
   * FFmpeg:
   * แปลงเสียงให้เป็น PCM 48kHz stereo
   * ซึ่งเหมาะสำหรับ Discord voice
   */
  const ffmpeg = spawn("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    "pipe:0",
    "-vn",
    "-ac",
    "2",
    "-ar",
    "48000",
    "-f",
    "s16le",
    "pipe:1"
  ]);

  ytdlp.stdout.pipe(ffmpeg.stdin);

  const resource = createAudioResource(ffmpeg.stdout, {
    inputType: StreamType.Raw,
    inlineVolume: false
  });

  player.play(resource);
  connection.subscribe(player);

  players.set(guildId, {
    connection,
    player,
    ytdlp,
    ffmpeg
  });

  player.on(AudioPlayerStatus.Playing, () => {
    console.log(`กำลังเล่น YouTube Live: ${url}`);
  });

  player.on(AudioPlayerStatus.Idle, () => {
    console.log("Audio player หยุดทำงาน");

    const current = players.get(guildId);

    if (current?.ytdlp === ytdlp) {
      try {
        ytdlp.kill("SIGKILL");
      } catch {}

      try {
        ffmpeg.kill("SIGKILL");
      } catch {}

      players.delete(guildId);
    }
  });

  ytdlp.on("error", err => {
    console.error("yt-dlp error:", err);
  });

  ffmpeg.on("error", err => {
    console.error("FFmpeg error:", err);
  });

  ytdlp.on("close", code => {
    console.log("yt-dlp exited:", code);
  });

  ffmpeg.on("close", code => {
    console.log("FFmpeg exited:", code);
  });

  connection.on(VoiceConnectionStatus.Ready, async () => {
    await interaction.editReply(
      "🔴 เชื่อมต่อแล้ว กำลังส่งเสียง YouTube Live เข้า Voice Channel"
    );
  });

  connection.on("error", error => {
    console.error("Voice connection error:", error);
  });
}

client.once("ready", () => {
  console.log(`🤖 ${client.user.tag} ออนไลน์แล้ว`);
});

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;

  try {
    if (interaction.commandName === "join") {
      const channel = getVoiceChannel(interaction);

      if (!channel) {
        return interaction.reply({
          content: "❌ คุณต้องอยู่ในห้อง Voice ก่อน",
          ephemeral: true
        });
      }

      const connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: interaction.guildId,
        adapterCreator: interaction.guild.voiceAdapterCreator,
        selfDeaf: true
      });

      const old = players.get(interaction.guildId);

      players.set(interaction.guildId, {
        ...(old || {}),
        connection
      });

      return interaction.reply(
        `✅ เข้าห้อง **${channel.name}** แล้ว`
      );
    }

    if (interaction.commandName === "playlive") {
      const url = interaction.options.getString("url", true);

      return playLive(interaction, url);
    }

    if (interaction.commandName === "stop") {
      const data = players.get(interaction.guildId);

      if (!data) {
        return interaction.reply("❌ ตอนนี้ไม่มีไลฟ์ที่กำลังเล่น");
      }

      stopPlayback(interaction.guildId);

      return interaction.reply("⏹️ หยุดเสียงแล้ว");
    }

    if (interaction.commandName === "leave") {
      stopPlayback(interaction.guildId);

      return interaction.reply("👋 ออกจากห้องเสียงแล้ว");
    }
  } catch (error) {
    console.error(error);

    const message = "❌ เกิดข้อผิดพลาด ดู Log ของบอทเพื่อดูรายละเอียด";

    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(message).catch(() => {});
    } else {
      await interaction.reply({
        content: message,
        ephemeral: true
      }).catch(() => {});
    }
  }
});

(async () => {
  await registerCommands();
  await client.login(TOKEN);
})();
