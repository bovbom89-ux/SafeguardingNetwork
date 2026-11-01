
require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");
const OpenAI = require("openai");

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags
} = require("discord.js");

// ==========================================
// CONFIGURATION
// ==========================================

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const AI_CHAT_CHANNEL_ID = process.env.AI_CHAT_CHANNEL_ID;

if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
  throw new Error(
    "Missing DISCORD_TOKEN, DISCORD_CLIENT_ID or DISCORD_GUILD_ID."
  );
}

const openai = OPENAI_API_KEY
  ? new OpenAI({ apiKey: OPENAI_API_KEY })
  : null;

const DATA_DIR = path.join(__dirname, "data");
const CONFIG_FILE = path.join(DATA_DIR, "guilds.json");
const WARNINGS_FILE = path.join(DATA_DIR, "warnings.json");

fs.mkdirSync(DATA_DIR, { recursive: true });

function loadJSON(file, fallback = {}) {
  try {
    return fs.existsSync(file)
      ? JSON.parse(fs.readFileSync(file, "utf8"))
      : fallback;
  } catch {
    return fallback;
  }
}

function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

const configs = loadJSON(CONFIG_FILE);
const warnings = loadJSON(WARNINGS_FILE);

function getConfig(guildId) {
  if (!configs[guildId]) {
    configs[guildId] = {
      ticketCategory: null,
      staffRole: null,
      logsChannel: null,
      panelChannel: null,
      safetyRole: null,
      onlineRole: null,
      maxOpenTickets: 2
    };

    saveJSON(CONFIG_FILE, configs);
  }

  return configs[guildId];
}

// ==========================================
// CLIENT
// ==========================================

// GuildMembers is deliberately NOT enabled.
// MessageContent must be enabled in the
// Discord Developer Portal for AI chat.

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const COLOUR = 0x018C8E;
const FOOTER = "The Safeguarding Network";

// ==========================================
// EMBEDS
// ==========================================

function makeEmbed(title, description) {
  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(COLOUR)
    .setFooter({ text: FOOTER })
    .setTimestamp();
}

// ==========================================
// TICKET CATEGORIES
// ==========================================

const TICKET_CATEGORIES = {
  general: {
    label: "General Enquiries",
    description: "General questions and enquiries about TSN.",
    title: "General Enquiry",
    message:
      "Thank you for contacting The Safeguarding Network.\n\nPlease explain your enquiry below. A member of our team will assist you as soon as possible."
  },

  personal: {
    label: "Personal Support",
    description: "Request assistance with a personal matter.",
    title: "Personal Support Request",
    message:
      "You have opened a personal support ticket.\n\nPlease share only the information necessary for our team to understand how we may assist you. You do not need to disclose anything you are uncomfortable sharing."
  },

  safety: {
    label: "Safety Concerns",
    description: "Raise a concern about someone's safety or wellbeing.",
    title: "Safety Concern",
    message:
      "This ticket is intended for raising concerns relating to someone's safety or wellbeing.\n\nPlease provide a brief description of your concern and any relevant information. Avoid sharing unnecessary identifying or sensitive personal information.\n\nIMPORTANT: This ticket system is not an emergency service. If someone is in immediate danger in the UK, call 999."
  },

  online: {
    label: "Online Concerns",
    description: "Raise concerns relating to online safety.",
    title: "Online Safety Concern",
    message:
      "This ticket is for concerns relating to online safety, digital interactions or potentially harmful online behaviour.\n\nPlease explain the nature of your concern. Do not share passwords, private account details or unnecessary personal information."
  },

  further: {
    label: "Further Assistance",
    description: "Request assistance with another matter.",
    title: "Further Assistance",
    message:
      "Thank you for contacting The Safeguarding Network.\n\nPlease explain what assistance you require, and our team will direct your enquiry appropriately."
  },

  report: {
    label: "Report a User",
    description: "Report a member to the TSN staff team.",
    title: "Report a User",
    message:
      "This ticket allows you to report a member of The Safeguarding Network.\n\nPlease explain what happened and provide relevant information. Avoid sharing unnecessary personal details. Please do not make false or deliberately misleading reports."
  },

  staffing: {
    label: "Staffing Enquiries",
    description: "Questions about staffing and staff applications.",
    title: "Staffing Enquiry",
    message:
      "Welcome to Staffing Enquiries.\n\nYou can use this ticket to ask questions about staff opportunities, applications, responsibilities or other staffing matters."
  }
};

// ==========================================
// LOGGING
// ==========================================

async function sendLog(guild, description) {
  const config = getConfig(guild.id);

  if (!config.logsChannel) return;

  const channel = guild.channels.cache.get(config.logsChannel);

  if (!channel || !channel.isTextBased()) return;

  await channel.send({
    embeds: [makeEmbed("System Log", description)]
  }).catch(console.error);
}

// ==========================================
// TICKET PANEL
// ==========================================

function createTicketPanel() {
  const embed = makeEmbed(
    "The Safeguarding Network Support Centre",
    [
      "> Welcome to The Safeguarding Network Support Centre, If you require assistance, have an enquiry or wish to raise a concern, select the most appropriate category below.",
      "",
      "__**Available Support Categories**__",
      "",
      "> • General Enquiries",
      "> • Personal Support",
      "> • Safety Concerns",
      "> • Online Concerns",
      "> • Further Assistance",
      "> • Report a User",
      "> • Staffing Enquiries",
      "",
      "__**Before opening a ticket**__",
      "",
      "> • Select the category most relevant to your enquiry.",
      "> • Treat staff members respectfully.",
      "> • Only share information relevant to your enquiry.",
      "> • Tickets are private to the member and authorised staff, but are not guaranteed confidential.",
      "",
      "> The Safeguarding Network is an independent community. This ticket system does not replace professional safeguarding services or emergency assistance.",
      "",
      "**Select a support category below to get started.**"
    ].join("\n")
  );

  const menu = new StringSelectMenuBuilder()
    .setCustomId("ticket_select")
    .setPlaceholder("Select a support category")
    .addOptions(
      Object.entries(TICKET_CATEGORIES).map(([value, category]) => ({
        label: category.label,
        description: category.description,
        value
      }))
    );

  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(menu)
    ]
  };
}

// ==========================================
// TICKET CREATION
// ==========================================

async function createTicket(interaction, categoryKey) {
  const guild = interaction.guild;
  const config = getConfig(guild.id);
  const category = TICKET_CATEGORIES[categoryKey];

  if (!category) {
    return interaction.reply({
      content: "That ticket category is invalid.",
      flags: MessageFlags.Ephemeral
    });
  }

  if (!config.ticketCategory || !config.staffRole) {
    return interaction.reply({
      content: "The ticket system has not been fully configured. Please contact a server administrator.",
      flags: MessageFlags.Ephemeral
    });
  }

  const discordCategory = guild.channels.cache.get(config.ticketCategory);
  const staffRole = guild.roles.cache.get(config.staffRole);

  if (
    !discordCategory ||
    discordCategory.type !== ChannelType.GuildCategory ||
    !staffRole
  ) {
    return interaction.reply({
      content: "The configured ticket category or staff role could not be found. Please contact an administrator.",
      flags: MessageFlags.Ephemeral
    });
  }

  const openTickets = guild.channels.cache.filter(channel =>
    channel.type === ChannelType.GuildText &&
    channel.topic?.includes(`ticket-owner:${interaction.user.id}`)
  );

  if (openTickets.size >= config.maxOpenTickets) {
    return interaction.reply({
      content: `You already have ${openTickets.size} open ticket(s). Please close an existing ticket before opening another.`,
      flags: MessageFlags.Ephemeral
    });
  }

  await interaction.deferReply({
    flags: MessageFlags.Ephemeral
  });

  let notificationRole = staffRole;

  if (categoryKey === "safety" && config.safetyRole) {
    notificationRole =
      guild.roles.cache.get(config.safetyRole) || staffRole;
  }

  if (categoryKey === "online" && config.onlineRole) {
    notificationRole =
      guild.roles.cache.get(config.onlineRole) || staffRole;
  }

  const safeName = interaction.user.username
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 15) || "member";

  try {
    const permissionOverwrites = [
      {
        id: guild.roles.everyone.id,
        deny: [PermissionFlagsBits.ViewChannel]
      },
      {
        id: interaction.user.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.EmbedLinks
        ]
      },
      {
        id: staffRole.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.ManageMessages
        ]
      },
      {
        id: client.user.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.ManageChannels
        ]
      }
    ];

    if (
      notificationRole.id !== staffRole.id &&
      notificationRole.id !== guild.roles.everyone.id
    ) {
      permissionOverwrites.push({
        id: notificationRole.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory
        ]
      });
    }

    const channel = await guild.channels.create({
      name: `${categoryKey}-${safeName}`,
      type: ChannelType.GuildText,
      parent: discordCategory.id,
      topic: `ticket-owner:${interaction.user.id} | ticket-type:${categoryKey}`,
      permissionOverwrites
    });

    const embed = makeEmbed(
      category.title,
      category.message
    );

    const closeButton = new ButtonBuilder()
      .setCustomId("ticket_close")
      .setLabel("Close Ticket")
      .setStyle(ButtonStyle.Danger);

    const row = new ActionRowBuilder().addComponents(closeButton);

    await channel.send({
      content: `${interaction.user} <@&${notificationRole.id}>`,
      allowedMentions: {
        users: [interaction.user.id],
        roles: [notificationRole.id]
      },
      embeds: [embed],
      components: [row]
    });

    await interaction.editReply({
      content: `Your ticket has been created: ${channel}`
    });

    await sendLog(
      guild,
      `A ticket was opened by ${interaction.user.tag}.\nCategory: ${category.label}\nChannel: ${channel}`
    );

  } catch (error) {
    console.error("Ticket creation failed:", error);

    await interaction.editReply({
      content: "The ticket could not be created. Please check the bot's channel permissions."
    });
  }
}

// ==========================================
// TICKET CLOSING
// ==========================================

async function closeTicket(interaction) {
  const channel = interaction.channel;
  const guild = interaction.guild;
  const config = getConfig(guild.id);

  const ownerMatch = channel.topic?.match(/ticket-owner:(\d+)/);

  if (!ownerMatch) {
    return interaction.reply({
      content: "This channel is not recognised as a ticket.",
      flags: MessageFlags.Ephemeral
    });
  }

  const ownerId = ownerMatch[1];
  const isOwner = interaction.user.id === ownerId;

  const member = await guild.members.fetch(interaction.user.id);

  const isStaff = config.staffRole
    ? member.roles.cache.has(config.staffRole)
    : false;

  const canManage = interaction.memberPermissions?.has(
    PermissionFlagsBits.ManageChannels
  );

  if (!isOwner && !isStaff && !canManage) {
    return interaction.reply({
      content: "You do not have permission to close this ticket.",
      flags: MessageFlags.Ephemeral
    });
  }

  await interaction.reply({
    embeds: [
      makeEmbed(
        "Ticket Closed",
        `This ticket has been closed by ${interaction.user}.`
      )
    ],
    components: []
  });

  await sendLog(
    guild,
    `Ticket closed.\nChannel: ${channel.name}\nClosed by: ${interaction.user.tag}\nTicket owner: <@${ownerId}>`
  );

  setTimeout(async () => {
    await channel.delete("Ticket closed").catch(console.error);
  }, 5000);
}

// ==========================================
// AI CHATBOT
// ==========================================

// Conversation history is held temporarily in memory.
// It is not written to the bot's JSON files.

const aiConversations = new Map();
const aiCooldowns = new Map();

const AI_MODEL = "gpt-4.1-mini";
const MAX_HISTORY_MESSAGES = 10;
const AI_COOLDOWN_MS = 4000;

const AI_SYSTEM_PROMPT = `
You are Safeguarding Assistant's AI chatbot in The Safeguarding Network (TSN).

Your purpose is to provide friendly, clear and useful general information
and answer everyday questions.

IMPORTANT GUIDELINES:

1. You are an AI assistant, not a human staff member.
2. You are not a professional safeguarding service, emergency service,
   therapist, doctor, lawyer or official authority.
3. Never claim to investigate, report, escalate or contact anyone.
4. Do not promise confidentiality or secrecy.
5. Do not ask users for passwords, addresses, phone numbers or unnecessary
   identifying information.
6. Do not encourage users to share sensitive personal information in
   a public Discord channel.
7. If someone describes immediate danger in the UK, advise them to call 999.
   If they are unsure what to do, encourage them to speak to a trusted adult
   or appropriate professional.
8. For safeguarding concerns, encourage users to contact an appropriate
   trusted adult or professional service. Do not attempt to investigate.
9. Respond calmly and supportively to distressing topics.
10. Do not provide instructions that facilitate harm, abuse, exploitation
    or dangerous behaviour.
11. Do not invent facts, policies, server rules or staff decisions.
12. Explain when you are uncertain.
13. Keep answers reasonably concise and easy to understand.
14. Do not claim to represent an official safeguarding authority.

The Safeguarding Network is an independent community.
`;

// ==========================================
// AI MESSAGE HANDLER
// ==========================================

async function handleAIMessage(message) {
  if (!openai || !AI_CHAT_CHANNEL_ID) return;
  if (message.author.bot || !message.guild) return;
  if (message.channel.id !== AI_CHAT_CHANNEL_ID) return;

  const now = Date.now();
  const lastMessage = aiCooldowns.get(message.author.id) || 0;

  if (now - lastMessage < AI_COOLDOWN_MS) return;

  aiCooldowns.set(message.author.id, now);

  const conversationKey = `${message.guild.id}:${message.author.id}`;

  if (!aiConversations.has(conversationKey)) {
    aiConversations.set(conversationKey, []);
  }

  const history = aiConversations.get(conversationKey);

  const userMessage = message.content.trim();

  if (!userMessage) return;

  if (userMessage.length > 4000) {
    return message.reply({
      content: "Please keep your message shorter so I can respond properly.",
      allowedMentions: { repliedUser: false }
    });
  }

  await message.channel.sendTyping().catch(() => {});

  try {
    const response = await openai.chat.completions.create({
      model: AI_MODEL,
      messages: [
        {
          role: "system",
          content: AI_SYSTEM_PROMPT
        },
        ...history,
        {
          role: "user",
          content: userMessage
        }
      ],
      max_completion_tokens: 600
    });

    const answer =
      response.choices?.[0]?.message?.content?.trim();

    if (!answer) {
      return message.reply({
        content: "I couldn't generate a response just now. Please try again.",
        allowedMentions: { repliedUser: false }
      });
    }

    history.push(
      { role: "user", content: userMessage },
      { role: "assistant", content: answer }
    );

    while (history.length > MAX_HISTORY_MESSAGES) {
      history.shift();
    }

    const safeAnswer = answer.slice(0, 1900);

    await message.reply({
      content: safeAnswer,
      allowedMentions: { repliedUser: false }
    });

  } catch (error) {
    console.error("AI chatbot error:", error);

    await message.reply({
      content: "The AI assistant is temporarily unavailable. Please try again later.",
      allowedMentions: { repliedUser: false }
    }).catch(console.error);
  }
}

// ==========================================
// SLASH COMMANDS
// ==========================================

const commands = [

  new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Check the bot response time."),

  new SlashCommandBuilder()
    .setName("serverinfo")
    .setDescription("View information about the server."),

  new SlashCommandBuilder()
    .setName("userinfo")
    .setDescription("View information about a member.")
    .addUserOption(option =>
      option.setName("member")
        .setDescription("The member to view.")
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("setup")
    .setDescription("Configure the ticket system.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption(option =>
      option.setName("ticket-category")
        .setDescription("Discord category where tickets will be created.")
        .addChannelTypes(ChannelType.GuildCategory)
    )
    .addRoleOption(option =>
      option.setName("staff-role")
        .setDescription("Role that can view and manage tickets.")
    )
    .addChannelOption(option =>
      option.setName("logs-channel")
        .setDescription("Channel for ticket and moderation logs.")
        .addChannelTypes(ChannelType.GuildText)
    )
    .addChannelOption(option =>
      option.setName("panel-channel")
        .setDescription("Channel where the ticket panel will be posted.")
        .addChannelTypes(ChannelType.GuildText)
    )
    .addRoleOption(option =>
      option.setName("safety-role")
        .setDescription("Optional role notified for Safety Concerns.")
    )
    .addRoleOption(option =>
      option.setName("online-role")
        .setDescription("Optional role notified for Online Concerns.")
    )
    .addIntegerOption(option =>
      option.setName("max-open-tickets")
        .setDescription("Maximum open tickets per member.")
        .setMinValue(1)
        .setMaxValue(5)
    ),

  new SlashCommandBuilder()
    .setName("warn")
    .setDescription("Issue a warning to a member.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption(option =>
      option.setName("member")
        .setDescription("Member to warn.")
        .setRequired(true)
    )
    .addStringOption(option =>
      option.setName("reason")
        .setDescription("Reason for the warning.")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("warnings")
    .setDescription("View a member's warnings.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption(option =>
      option.setName("member")
        .setDescription("Member to check.")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("clear-warnings")
    .setDescription("Clear a member's warnings.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption(option =>
      option.setName("member")
        .setDescription("Member whose warnings should be cleared.")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("timeout")
    .setDescription("Temporarily timeout a member.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption(option =>
      option.setName("member")
        .setDescription("Member to timeout.")
        .setRequired(true)
    )
    .addIntegerOption(option =>
      option.setName("minutes")
        .setDescription("Timeout duration in minutes.")
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(40320)
    )
    .addStringOption(option =>
      option.setName("reason")
        .setDescription("Reason for the timeout.")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("untimeout")
    .setDescription("Remove a member's timeout.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption(option =>
      option.setName("member")
        .setDescription("Member to remove the timeout from.")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("kick")
    .setDescription("Remove a member from the server.")
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
    .addUserOption(option =>
      option.setName("member")
        .setDescription("Member to kick.")
        .setRequired(true)
    )
    .addStringOption(option =>
      option.setName("reason")
        .setDescription("Reason for the kick.")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("ban")
    .setDescription("Ban a member from the server.")
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addUserOption(option =>
      option.setName("member")
        .setDescription("Member to ban.")
        .setRequired(true)
    )
    .addStringOption(option =>
      option.setName("reason")
        .setDescription("Reason for the ban.")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("unban")
    .setDescription("Unban a user.")
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addStringOption(option =>
      option.setName("user-id")
        .setDescription("Discord user ID.")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("purge")
    .setDescription("Delete multiple messages.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addIntegerOption(option =>
      option.setName("amount")
        .setDescription("Number of messages to delete.")
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(100)
    ),

  new SlashCommandBuilder()
    .setName("staff-notice")
    .setDescription("Send a notice to the configured staff role.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(option =>
      option.setName("message")
        .setDescription("Notice to send.")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("lockdown")
    .setDescription("Lock a channel against member messages.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addChannelOption(option =>
      option.setName("channel")
        .setDescription("Channel to lock. Defaults to this channel.")
        .addChannelTypes(ChannelType.GuildText)
    ),

  new SlashCommandBuilder()
    .setName("unlock")
    .setDescription("Unlock a previously locked channel.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addChannelOption(option =>
      option.setName("channel")
        .setDescription("Channel to unlock. Defaults to this channel.")
        .addChannelTypes(ChannelType.GuildText)
    )

].map(command => command.toJSON());

// ==========================================
// SETUP COMMAND
// ==========================================

async function handleSetup(interaction) {
  const config = getConfig(interaction.guild.id);

  const ticketCategory = interaction.options.getChannel("ticket-category");
  const staffRole = interaction.options.getRole("staff-role");
  const logsChannel = interaction.options.getChannel("logs-channel");
  const panelChannel = interaction.options.getChannel("panel-channel");
  const safetyRole = interaction.options.getRole("safety-role");
  const onlineRole = interaction.options.getRole("online-role");
  const maxTickets = interaction.options.getInteger("max-open-tickets");

  const supplied = [
    ticketCategory,
    staffRole,
    logsChannel,
    panelChannel,
    safetyRole,
    onlineRole,
    maxTickets
  ].some(Boolean);

  if (!supplied) {
    return interaction.reply({
      content: "Provide at least one configuration option to update the ticket system.",
      flags: MessageFlags.Ephemeral
    });
  }

  if (ticketCategory) config.ticketCategory = ticketCategory.id;
  if (staffRole) config.staffRole = staffRole.id;
  if (logsChannel) config.logsChannel = logsChannel.id;
  if (panelChannel) config.panelChannel = panelChannel.id;
  if (safetyRole) config.safetyRole = safetyRole.id;
  if (onlineRole) config.onlineRole = onlineRole.id;
  if (maxTickets) config.maxOpenTickets = maxTickets;

  saveJSON(CONFIG_FILE, configs);

  let panelStatus = "";

  if (panelChannel) {
    try {
      await panelChannel.send(createTicketPanel());
      panelStatus = "\nTicket panel published successfully.";
    } catch (error) {
      console.error(error);
      panelStatus = "\nCould not publish the ticket panel. Check the bot's permissions.";
    }
  }

  await interaction.reply({
    embeds: [
      makeEmbed(
        "Setup Updated",
        [
          `Ticket category: ${config.ticketCategory ? `<#${config.ticketCategory}>` : "Not configured"}`,
          `Staff role: ${config.staffRole ? `<@&${config.staffRole}>` : "Not configured"}`,
          `Logs channel: ${config.logsChannel ? `<#${config.logsChannel}>` : "Not configured"}`,
          `Panel channel: ${config.panelChannel ? `<#${config.panelChannel}>` : "Not configured"}`,
          `Safety notification role: ${config.safetyRole ? `<@&${config.safetyRole}>` : "Not configured"}`,
          `Online notification role: ${config.onlineRole ? `<@&${config.onlineRole}>` : "Not configured"}`,
          `Maximum open tickets: ${config.maxOpenTickets}`,
          panelStatus
        ].join("\n")
      )
    ],
    flags: MessageFlags.Ephemeral
  });

  await sendLog(
    interaction.guild,
    `Ticket configuration updated by ${interaction.user.tag}.`
  );
}

// ==========================================
// COMMAND HANDLER
// ==========================================

async function handleCommand(interaction) {
  const { commandName, guild } = interaction;

  if (commandName === "ping") {
    return interaction.reply({
      embeds: [
        makeEmbed("Pong", `Response time: ${client.ws.ping}ms`)
      ],
      flags: MessageFlags.Ephemeral
    });
  }

  if (commandName === "serverinfo") {
    return interaction.reply({
      embeds: [
        makeEmbed(
          guild.name,
          [
            `Owner: <@${guild.ownerId}>`,
            `Members: ${guild.memberCount}`,
            `Channels: ${guild.channels.cache.size}`,
            `Created: <t:${Math.floor(guild.createdTimestamp / 1000)}:D>`
          ].join("\n")
        )
      ],
      flags: MessageFlags.Ephemeral
    });
  }

  if (commandName === "userinfo") {
    const user = interaction.options.getUser("member") || interaction.user;
    const target = await guild.members.fetch(user.id).catch(() => null);

    return interaction.reply({
      embeds: [
        makeEmbed(
          "Member Information",
          [
            `Username: ${user.tag}`,
            `User ID: ${user.id}`,
            `Account created: <t:${Math.floor(user.createdTimestamp / 1000)}:F>`,
            `Joined server: ${target?.joinedTimestamp ? `<t:${Math.floor(target.joinedTimestamp / 1000)}:F>` : "Unknown"}`
          ].join("\n")
        )
      ],
      flags: MessageFlags.Ephemeral
    });
  }

  if (commandName === "setup") {
    return handleSetup(interaction);
  }

  if (commandName === "warn") {
    const user = interaction.options.getUser("member");
    const reason = interaction.options.getString("reason");

    if (!warnings[guild.id]) warnings[guild.id] = {};
    if (!warnings[guild.id][user.id]) warnings[guild.id][user.id] = [];

    warnings[guild.id][user.id].push({
      reason,
      moderator: interaction.user.id,
      date: new Date().toISOString()
    });

    saveJSON(WARNINGS_FILE, warnings);

    await user.send({
      embeds: [
        makeEmbed(
          "You Have Received a Warning",
          `Server: ${guild.name}\nReason: ${reason}`
        )
      ]
    }).catch(() => {});

    await interaction.reply({
      embeds: [
        makeEmbed(
          "Warning Issued",
          `${user} has received a warning.\nReason: ${reason}`
        )
      ],
      flags: MessageFlags.Ephemeral
    });

    return sendLog(
      guild,
      `${user.tag} was warned by ${interaction.user.tag}.\nReason: ${reason}`
    );
  }

  if (commandName === "warnings") {
    const user = interaction.options.getUser("member");
    const list = warnings[guild.id]?.[user.id] || [];

    const description = list.length
      ? list.map((warning, index) =>
          `**${index + 1}.** ${warning.reason}\nModerator: <@${warning.moderator}>\nDate: <t:${Math.floor(new Date(warning.date).getTime() / 1000)}:F>`
        ).join("\n\n")
      : "This member has no recorded warnings.";

    return interaction.reply({
      embeds: [
        makeEmbed(`Warnings: ${user.tag}`, description)
      ],
      flags: MessageFlags.Ephemeral
    });
  }

  if (commandName === "clear-warnings") {
    const user = interaction.options.getUser("member");

    if (warnings[guild.id]) {
      delete warnings[guild.id][user.id];
      saveJSON(WARNINGS_FILE, warnings);
    }

    await interaction.reply({
      embeds: [
        makeEmbed(
          "Warnings Cleared",
          `Warnings for ${user} have been cleared.`
        )
      ],
      flags: MessageFlags.Ephemeral
    });

    return sendLog(
      guild,
      `Warnings cleared for ${user.tag} by ${interaction.user.tag}.`
    );
  }

  if (commandName === "timeout") {
    const user = interaction.options.getUser("member");
    const minutes = interaction.options.getInteger("minutes");
    const reason = interaction.options.getString("reason");

    const target = await guild.members.fetch(user.id);
    await target.timeout(minutes * 60 * 1000, reason);

    await interaction.reply({
      embeds: [
        makeEmbed(
          "Member Timed Out",
          `${user} has been timed out for ${minutes} minutes.\nReason: ${reason}`
        )
      ],
      flags: MessageFlags.Ephemeral
    });

    return sendLog(
      guild,
      `${user.tag} was timed out by ${interaction.user.tag} for ${minutes} minutes.\nReason: ${reason}`
    );
  }

  if (commandName === "untimeout") {
    const user = interaction.options.getUser("member");
    const target = await guild.members.fetch(user.id);

    await target.timeout(null);

    await interaction.reply({
      embeds: [
        makeEmbed(
          "Timeout Removed",
          `The timeout for ${user} has been removed.`
        )
      ],
      flags: MessageFlags.Ephemeral
    });

    return sendLog(
      guild,
      `Timeout removed from ${user.tag} by ${interaction.user.tag}.`
    );
  }

  if (commandName === "kick") {
    const user = interaction.options.getUser("member");
    const reason = interaction.options.getString("reason");
    const target = await guild.members.fetch(user.id);

    await target.kick(reason);

    await interaction.reply({
      embeds: [
        makeEmbed(
          "Member Kicked",
          `${user.tag} has been removed.\nReason: ${reason}`
        )
      ],
      flags: MessageFlags.Ephemeral
    });

    return sendLog(
      guild,
      `${user.tag} was kicked by ${interaction.user.tag}.\nReason: ${reason}`
    );
  }

  if (commandName === "ban") {
    const user = interaction.options.getUser("member");
    const reason = interaction.options.getString("reason");

    await guild.members.ban(user.id, { reason });

    await interaction.reply({
      embeds: [
        makeEmbed(
          "Member Banned",
          `${user.tag} has been banned.\nReason: ${reason}`
        )
      ],
      flags: MessageFlags.Ephemeral
    });

    return sendLog(
      guild,
      `${user.tag} was banned by ${interaction.user.tag}.\nReason: ${reason}`
    );
  }

  if (commandName === "unban") {
    const userId = interaction.options.getString("user-id");

    await guild.members.unban(userId);

    await interaction.reply({
      embeds: [
        makeEmbed(
          "User Unbanned",
          `User ${userId} has been unbanned.`
        )
      ],
      flags: MessageFlags.Ephemeral
    });

    return sendLog(
      guild,
      `User ${userId} was unbanned by ${interaction.user.tag}.`
    );
  }

  if (commandName === "purge") {
    const amount = interaction.options.getInteger("amount");

    const deleted = await interaction.channel.bulkDelete(amount, true);

    return interaction.reply({
      embeds: [
        makeEmbed(
          "Messages Deleted",
          `${deleted.size} messages were deleted.`
        )
      ],
      flags: MessageFlags.Ephemeral
    });
  }

  if (commandName === "staff-notice") {
    const config = getConfig(guild.id);
    const message = interaction.options.getString("message");

    if (!config.staffRole) {
      return interaction.reply({
        content: "No staff role has been configured. Use /setup first.",
        flags: MessageFlags.Ephemeral
      });
    }

    await interaction.channel.send({
      content: `<@&${config.staffRole}>`,
      allowedMentions: {
        roles: [config.staffRole]
      },
      embeds: [
        makeEmbed("Staff Notice", message)
      ]
    });

    return interaction.reply({
      content: "Staff notice published.",
      flags: MessageFlags.Ephemeral
    });
  }

  if (commandName === "lockdown" || commandName === "unlock") {
    const channel =
      interaction.options.getChannel("channel") || interaction.channel;

    const locked = commandName === "lockdown";

    await channel.permissionOverwrites.edit(
      guild.roles.everyone,
      {
        SendMessages: !locked
      }
    );

    await interaction.reply({
      embeds: [
        makeEmbed(
          locked ? "Channel Locked" : "Channel Unlocked",
          `${channel} has been ${locked ? "locked" : "unlocked"}.`
        )
      ],
      flags: MessageFlags.Ephemeral
    });

    return sendLog(
      guild,
      `${channel.name} was ${locked ? "locked" : "unlocked"} by ${interaction.user.tag}.`
    );
  }
}

// ==========================================
// INTERACTION EVENTS
// ==========================================

client.on("interactionCreate", async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      return await handleCommand(interaction);
    }

    if (
      interaction.isStringSelectMenu() &&
      interaction.customId === "ticket_select"
    ) {
      return await createTicket(interaction, interaction.values[0]);
    }

    if (
      interaction.isButton() &&
      interaction.customId === "ticket_close"
    ) {
      return await closeTicket(interaction);
    }

  } catch (error) {
    console.error("Interaction error:", error);

    const response = {
      content: "An error occurred while processing your request. Please try again or contact a server administrator.",
      flags: MessageFlags.Ephemeral
    };

    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(response).catch(console.error);
    } else {
      await interaction.reply(response).catch(console.error);
    }
  }
});

// ==========================================
// MESSAGE EVENTS - AI CHAT
// ==========================================

client.on("messageCreate", async message => {
  try {
    await handleAIMessage(message);
  } catch (error) {
    console.error("Message handler error:", error);
  }
});

// ==========================================
// READY EVENT
// ==========================================

client.once("clientReady", async readyClient => {
  console.log(
    `Safeguarding Assistant is online as ${readyClient.user.tag}.`
  );

  if (!openai) {
    console.log("AI chatbot disabled: OPENAI_API_KEY is missing.");
  } else if (!AI_CHAT_CHANNEL_ID) {
    console.log("AI chatbot disabled: AI_CHAT_CHANNEL_ID is missing.");
  } else {
    console.log(`AI chatbot enabled in channel ${AI_CHAT_CHANNEL_ID}.`);
  }

  try {
    const rest = new REST({ version: "10" }).setToken(TOKEN);

    await rest.put(
      Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
      { body: commands }
    );

    console.log(
      `${commands.length} slash commands registered successfully.`
    );

  } catch (error) {
    console.error("Command registration failed:", error);
  }
});

// ==========================================
// LOGIN
// ==========================================

client.login(TOKEN);
