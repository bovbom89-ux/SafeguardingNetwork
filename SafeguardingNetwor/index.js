
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
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  AttachmentBuilder
} = require("discord.js");

// ==========================================
// CONFIGURATION
// ==========================================

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

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
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    console.error(`Could not load ${file}:`, error);
    return fallback;
  }
}

function saveJSON(file, data) {
  const temporaryFile = `${file}.tmp`;

  fs.writeFileSync(
    temporaryFile,
    JSON.stringify(data, null, 2)
  );

  fs.renameSync(temporaryFile, file);
}

const configs = loadJSON(CONFIG_FILE);
const warnings = loadJSON(WARNINGS_FILE);

function getConfig(guildId) {
  if (!configs[guildId]) configs[guildId] = {};

  const config = configs[guildId];

  config.staffRole ??= null;
  config.panelChannel ??= null;
  config.panelMessage ??= null;
  config.ticketCategory ??= null;
  config.logsChannel ??= null;
  config.aiChannel ??= null;
  config.aiEnabled ??= true;
  config.ticketRecords ??= {};

  return config;
}

const COLOUR = 0x018C8E;
const FOOTER = "The Safeguarding Network";

// ==========================================
// CLIENT
// ==========================================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

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
// GENERAL HELPERS
// ==========================================

function isAdmin(interaction) {
  return interaction.memberPermissions?.has(
    PermissionFlagsBits.Administrator
  );
}

function isSupport(member, config) {
  return (
    member.permissions.has(PermissionFlagsBits.Administrator) ||
    (
      config.staffRole &&
      member.roles.cache.has(config.staffRole)
    )
  );
}

async function getTicketMember(interaction) {
  return interaction.guild.members.fetch(interaction.user.id);
}

async function checkSupportPermission(interaction) {
  const config = getConfig(interaction.guild.id);
  const member = await getTicketMember(interaction);

  if (!isSupport(member, config)) {
    await interaction.reply({
      content: "Only the configured support team can use this ticket control.",
      flags: MessageFlags.Ephemeral
    });

    return false;
  }

  return true;
}

async function getTicketRecord(channel) {
  const config = getConfig(channel.guild.id);
  const savedRecord = config.ticketRecords[channel.id];

  if (savedRecord) return savedRecord;

  const ownerMatch = channel.topic?.match(/ticket-owner:(\d+)/);
  if (!ownerMatch) return null;

  return {
    owner: ownerMatch[1],
    category: channel.topic.match(/ticket-type:([a-z]+)/)?.[1] || "general",
    claimedBy: null,
    openedAt: new Date().toISOString()
  };
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
// AUTOMATIC CHANNEL CREATION
// ==========================================

async function ensureTicketChannels(guild, config) {
  const botMember = await guild.members.fetch(client.user.id);

  let ticketCategory = config.ticketCategory
    ? await guild.channels.fetch(config.ticketCategory).catch(() => null)
    : null;

  const categoryPermissions = [
    {
      id: guild.roles.everyone.id,
      deny: [PermissionFlagsBits.ViewChannel]
    },
    {
      id: botMember.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.ManageMessages,
        PermissionFlagsBits.ReadMessageHistory
      ]
    }
  ];

  if (config.staffRole) {
    categoryPermissions.push({
      id: config.staffRole,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageMessages
      ]
    });
  }

  if (
    !ticketCategory ||
    ticketCategory.type !== ChannelType.GuildCategory
  ) {
    ticketCategory = await guild.channels.create({
      name: "Support Tickets",
      type: ChannelType.GuildCategory,
      permissionOverwrites: categoryPermissions
    });
  } else {
    await ticketCategory.permissionOverwrites.set(categoryPermissions);
  }

  config.ticketCategory = ticketCategory.id;

  let logsChannel = config.logsChannel
    ? await guild.channels.fetch(config.logsChannel).catch(() => null)
    : null;

  const logPermissions = [
    {
      id: guild.roles.everyone.id,
      deny: [PermissionFlagsBits.ViewChannel]
    },
    {
      id: botMember.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.ManageChannels
      ]
    }
  ];

  if (config.staffRole) {
    logPermissions.push({
      id: config.staffRole,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.EmbedLinks
      ]
    });
  }

  if (
    !logsChannel ||
    logsChannel.type !== ChannelType.GuildText
  ) {
    logsChannel = await guild.channels.create({
      name: "support-logs",
      type: ChannelType.GuildText,
      permissionOverwrites: logPermissions
    });
  } else {
    await logsChannel.permissionOverwrites.set(logPermissions);
  }

  config.logsChannel = logsChannel.id;

  saveJSON(CONFIG_FILE, configs);

  return { ticketCategory, logsChannel };
}

// ==========================================
// LOGGING
// ==========================================

async function sendLog(guild, description, files = []) {
  const config = getConfig(guild.id);

  if (!config.logsChannel) {
    console.warn("No support logs channel is configured.");
    return false;
  }

  const channel = await guild.channels
    .fetch(config.logsChannel)
    .catch(() => null);

  if (!channel || !channel.isTextBased()) {
    console.error("The support logs channel could not be found.");
    return false;
  }

  await channel.send({
    embeds: [makeEmbed("Support System Log", description)],
    files
  });

  return true;
}

// ==========================================
// TICKET PANEL
// ==========================================

function createTicketPanel() {
  const embed = makeEmbed(
    "TSN | Support Centre",
    [
      "Welcome to The Safeguarding Network Support Centre. If you require assistance, have an enquiry or wish to raise a concern, select the most appropriate category below.",
      "",
      "**Available Support Categories**",
      "",
      "> General Enquiries",
      "> Personal Support",
      "> Safety Concerns",
      "> Online Concerns",
      "> Further Assistance",
      "> Report a User",
      "> Staffing Enquiries",
      "",
      "**Before opening a ticket**",
      "",
      "> Select the category most relevant to your enquiry.",
      "> Treat staff members respectfully.",
      "> Only share information relevant to your enquiry.",
      "> Tickets are private to the member and authorised staff, but are not guaranteed confidential.",
      "",
      "The Safeguarding Network is an independent community. This ticket system does not replace professional safeguarding services or emergency assistance.",
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

async function publishTicketPanel(channel, config) {
  const panel = createTicketPanel();

  if (config.panelMessage && config.panelChannel === channel.id) {
    const oldMessage = await channel.messages
      .fetch(config.panelMessage)
      .catch(() => null);

    if (oldMessage) {
      await oldMessage.edit(panel);
      return oldMessage;
    }
  }

  const message = await channel.send(panel);

  config.panelMessage = message.id;
  config.panelChannel = channel.id;

  saveJSON(CONFIG_FILE, configs);

  return message;
}

// ==========================================
// TICKET EMBEDS AND BUTTONS
// ==========================================

function createTicketEmbed(record) {
  const category = TICKET_CATEGORIES[record.category];

  return makeEmbed(
    category?.title || "Support Ticket",
    [
      category?.message || "Welcome to your support ticket.",
      "",
      "**Ticket Information**",
      `Category: ${category?.label || "Unknown"}`,
      `Status: ${record.claimedBy ? "Claimed" : "Unclaimed"}`,
      `Assigned staff: ${record.claimedBy ? `<@${record.claimedBy}>` : "None"}`,
      `Ticket owner: <@${record.owner}>`
    ].join("\n")
  );
}

function createTicketButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("ticket_claim")
      .setLabel("Claim")
      .setStyle(ButtonStyle.Success),

    new ButtonBuilder()
      .setCustomId("ticket_close")
      .setLabel("Close")
      .setStyle(ButtonStyle.Danger),

    new ButtonBuilder()
      .setCustomId("ticket_modpanel")
      .setLabel("Mod Panel")
      .setStyle(ButtonStyle.Secondary)
  );
}

async function updateTicketEmbed(channel, record) {
  const messages = await channel.messages.fetch({ limit: 50 });

  const ticketMessage = messages.find(message =>
    message.author.id === client.user.id &&
    message.components.some(row =>
      row.components.some(component =>
        component.customId === "ticket_claim"
      )
    )
  );

  if (!ticketMessage) {
    throw new Error("Could not find the ticket control message.");
  }

  await ticketMessage.edit({
    embeds: [createTicketEmbed(record)],
    components: [createTicketButtons()]
  });
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

  if (!config.staffRole) {
    return interaction.reply({
      content: "The ticket system has not been configured. Please contact an administrator.",
      flags: MessageFlags.Ephemeral
    });
  }

  const staffRole = await guild.roles
    .fetch(config.staffRole)
    .catch(() => null);

  if (!staffRole) {
    return interaction.reply({
      content: "The configured support role could not be found.",
      flags: MessageFlags.Ephemeral
    });
  }

  await interaction.deferReply({
    flags: MessageFlags.Ephemeral
  });

  try {
    const { ticketCategory } =
      await ensureTicketChannels(guild, config);

    const channels = await guild.channels.fetch();

    const openTickets = channels.filter(channel =>
      channel.type === ChannelType.GuildText &&
      channel.topic?.includes(`ticket-owner:${interaction.user.id}`)
    );

    if (openTickets.size >= 2) {
      return interaction.editReply({
        content: "You already have two open tickets. Please wait for an existing ticket to be closed."
      });
    }

    const safeName = interaction.user.username
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "")
      .slice(0, 15) || "member";

    const channel = await guild.channels.create({
      name: `${categoryKey}-${safeName}`,
      type: ChannelType.GuildText,
      parent: ticketCategory.id,
      topic: `ticket-owner:${interaction.user.id} | ticket-type:${categoryKey}`,
      permissionOverwrites: [
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
            PermissionFlagsBits.ManageChannels,
            PermissionFlagsBits.ManageMessages,
            PermissionFlagsBits.AttachFiles,
            PermissionFlagsBits.EmbedLinks
          ]
        }
      ]
    });

    const record = {
      owner: interaction.user.id,
      category: categoryKey,
      claimedBy: null,
      openedAt: new Date().toISOString()
    };

    config.ticketRecords[channel.id] = record;
    saveJSON(CONFIG_FILE, configs);

    await channel.send({
      content: `${interaction.user} <@&${staffRole.id}>`,
      allowedMentions: {
        users: [interaction.user.id],
        roles: [staffRole.id]
      },
      embeds: [createTicketEmbed(record)],
      components: [createTicketButtons()]
    });

    await interaction.editReply({
      content: `Your ticket has been created: ${channel}`
    });

    await sendLog(
      guild,
      `Ticket opened.\nOwner: <@${interaction.user.id}>\nCategory: ${category.label}\nChannel: ${channel}`
    );

  } catch (error) {
    console.error("Ticket creation failed:", error);

    await interaction.editReply({
      content: "The ticket could not be created. Please check the bot's channel permissions."
    });
  }
}

// ==========================================
// CLAIM TICKET
// ==========================================

async function claimTicket(interaction) {
  if (!(await checkSupportPermission(interaction))) return;

  const channel = interaction.channel;
  const config = getConfig(interaction.guild.id);
  const record = await getTicketRecord(channel);

  if (!record) {
    return interaction.reply({
      content: "This channel is not recognised as a ticket.",
      flags: MessageFlags.Ephemeral
    });
  }

  if (record.claimedBy) {
    return interaction.reply({
      content: record.claimedBy === interaction.user.id
        ? "You have already claimed this ticket."
        : `This ticket has already been claimed by <@${record.claimedBy}>.`,
      flags: MessageFlags.Ephemeral
    });
  }

  record.claimedBy = interaction.user.id;
  config.ticketRecords[channel.id] = record;
  saveJSON(CONFIG_FILE, configs);

  await updateTicketEmbed(channel, record);

  await interaction.reply({
    content: "You have successfully claimed this ticket.",
    flags: MessageFlags.Ephemeral
  });

  await sendLog(
    interaction.guild,
    `Ticket claimed.\nChannel: ${channel}\nClaimed by: ${interaction.user}`
  );
}

// ==========================================
// TICKET TRANSCRIPTS
// ==========================================

async function createTranscript(channel) {
  let allMessages = [];
  let lastMessageId = null;

  while (true) {
    const options = { limit: 100 };

    if (lastMessageId) {
      options.before = lastMessageId;
    }

    const messages = await channel.messages.fetch(options);

    if (messages.size === 0) break;

    allMessages.push(...messages.values());

    lastMessageId = messages.last().id;

    if (messages.size < 100) break;
  }

  allMessages.sort(
    (a, b) => a.createdTimestamp - b.createdTimestamp
  );

  const lines = allMessages.map(message => {
    const timestamp = new Date(
      message.createdTimestamp
    ).toISOString();

    const attachments = [...message.attachments.values()]
      .map(file => file.url)
      .join(", ");

    const embeds = message.embeds.length
      ? `[${message.embeds.length} embed(s)]`
      : "";

    return [
      `[${timestamp}] ${message.author.tag}:`,
      message.content || "[No text content]",
      attachments ? `Attachments: ${attachments}` : "",
      embeds
    ].filter(Boolean).join("\n");
  });

  return Buffer.from(
    lines.join("\n\n") || "No messages recorded.",
    "utf8"
  );
}

// ==========================================
// CLOSE TICKET
// ==========================================

async function requestTicketClose(interaction) {
  if (!(await checkSupportPermission(interaction))) return;

  const record = await getTicketRecord(interaction.channel);

  if (!record) {
    return interaction.reply({
      content: "This channel is not recognised as a ticket.",
      flags: MessageFlags.Ephemeral
    });
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("ticket_close_confirm")
      .setLabel("Confirm Close")
      .setStyle(ButtonStyle.Danger),

    new ButtonBuilder()
      .setCustomId("ticket_close_cancel")
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Secondary)
  );

  return interaction.reply({
    embeds: [
      makeEmbed(
        "Close Ticket",
        "Are you sure you want to close this ticket? A transcript will be saved to the private support logs channel."
      )
    ],
    components: [row],
    flags: MessageFlags.Ephemeral
  });
}

async function finishTicketClose(interaction) {
  if (!(await checkSupportPermission(interaction))) return;

  const channel = interaction.channel;
  const config = getConfig(interaction.guild.id);
  const record = await getTicketRecord(channel);

  if (!record) {
    return interaction.reply({
      content: "This channel is not recognised as a ticket.",
      flags: MessageFlags.Ephemeral
    });
  }

  await interaction.deferUpdate();

  try {
    if (!config.logsChannel) {
      throw new Error("No support logs channel is configured.");
    }

    const transcript = await createTranscript(channel);

    const transcriptFile = new AttachmentBuilder(
      transcript,
      { name: `transcript-${channel.id}.txt` }
    );

    const logSaved = await sendLog(
      interaction.guild,
      [
        "Ticket closed.",
        `Channel: ${channel.name}`,
        `Ticket owner: <@${record.owner}>`,
        `Closed by: ${interaction.user}`,
        `Category: ${TICKET_CATEGORIES[record.category]?.label || "Unknown"}`,
        "Messages included: Transcript attached."
      ].join("\n"),
      [transcriptFile]
    );

    if (!logSaved) {
      throw new Error("The transcript could not be delivered to support logs.");
    }

    delete config.ticketRecords[channel.id];
    saveJSON(CONFIG_FILE, configs);

    await channel.send({
      embeds: [
        makeEmbed(
          "Ticket Closed",
          `This ticket has been closed by ${interaction.user}.\n\nThe transcript has been saved to the support logs channel.`
        )
      ],
      components: []
    });

    await interaction.editReply({
      content: "The ticket has been closed and its transcript has been saved.",
      embeds: [],
      components: []
    });

    setTimeout(async () => {
      await channel.delete("Ticket closed").catch(console.error);
    }, 5000);

  } catch (error) {
    console.error("Ticket closing failed:", error);

    await interaction.followUp({
      content: "The ticket could not be closed because its transcript was not successfully saved. The ticket has been left open.",
      flags: MessageFlags.Ephemeral
    }).catch(console.error);
  }
}

// ==========================================
// TICKET MODERATION PANEL
// ==========================================

function createModPanel() {
  const embed = makeEmbed(
    "Ticket Management",
    "Use the controls below to manage this support ticket. These controls are only available to the configured support team."
  );

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("ticket_rename")
      .setLabel("Rename")
      .setStyle(ButtonStyle.Secondary),

    new ButtonBuilder()
      .setCustomId("ticket_add_member")
      .setLabel("Add Member")
      .setStyle(ButtonStyle.Secondary),

    new ButtonBuilder()
      .setCustomId("ticket_remove_member")
      .setLabel("Remove Member")
      .setStyle(ButtonStyle.Secondary)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("ticket_reassign")
      .setLabel("Reassign")
      .setStyle(ButtonStyle.Secondary),

    new ButtonBuilder()
      .setCustomId("ticket_change_category")
      .setLabel("Change Category")
      .setStyle(ButtonStyle.Secondary),

    new ButtonBuilder()
      .setCustomId("ticket_information")
      .setLabel("Ticket Info")
      .setStyle(ButtonStyle.Primary)
  );

  return {
    embeds: [embed],
    components: [row1, row2]
  };
}

async function openModPanel(interaction) {
  if (!(await checkSupportPermission(interaction))) return;

  const record = await getTicketRecord(interaction.channel);

  if (!record) {
    return interaction.reply({
      content: "This channel is not recognised as a ticket.",
      flags: MessageFlags.Ephemeral
    });
  }

  return interaction.reply({
    ...createModPanel(),
    flags: MessageFlags.Ephemeral
  });
}

// ==========================================
// MODERATION MODALS
// ==========================================

function createTicketModal(
  customId,
  title,
  fieldId,
  label,
  placeholder
) {
  const modal = new ModalBuilder()
    .setCustomId(customId)
    .setTitle(title);

  const input = new TextInputBuilder()
    .setCustomId(fieldId)
    .setLabel(label)
    .setPlaceholder(placeholder)
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(100);

  modal.addComponents(
    new ActionRowBuilder().addComponents(input)
  );

  return modal;
}

async function showTicketModal(interaction, type) {
  if (!(await checkSupportPermission(interaction))) return;

  const details = {
    rename: [
      "ticket_rename_modal",
      "Rename Ticket",
      "new_name",
      "New channel name",
      "Enter the new ticket channel name."
    ],
    add: [
      "ticket_add_modal",
      "Add Member",
      "user_id",
      "Member user ID",
      "Enter the Discord user ID."
    ],
    remove: [
      "ticket_remove_modal",
      "Remove Member",
      "user_id",
      "Member user ID",
      "Enter the Discord user ID."
    ],
    reassign: [
      "ticket_reassign_modal",
      "Reassign Ticket",
      "user_id",
      "New staff member user ID",
      "Enter the new support member's Discord user ID."
    ]
  };

  const [customId, title, fieldId, label, placeholder] =
    details[type];

  await interaction.showModal(
    createTicketModal(
      `${customId}:${interaction.channel.id}`,
      title,
      fieldId,
      label,
      placeholder
    )
  );
}

// ==========================================
// TICKET MODAL SUBMISSIONS
// ==========================================

async function handleTicketModal(interaction) {
  if (!(await checkSupportPermission(interaction))) return;

  const channelId = interaction.customId.split(":")[1];

  const channel = await interaction.guild.channels
    .fetch(channelId)
    .catch(() => null);

  if (!channel || channel.type !== ChannelType.GuildText) {
    return interaction.reply({
      content: "The ticket channel could not be found.",
      flags: MessageFlags.Ephemeral
    });
  }

  const config = getConfig(interaction.guild.id);
  const record = await getTicketRecord(channel);

  if (!record) {
    return interaction.reply({
      content: "This channel is not recognised as a ticket.",
      flags: MessageFlags.Ephemeral
    });
  }

  const isRename = interaction.customId.startsWith(
    "ticket_rename_modal"
  );

  const value = interaction.fields.getTextInputValue(
    isRename ? "new_name" : "user_id"
  ).trim();

  if (isRename) {
    const safeName = value
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 90);

    if (!safeName) {
      return interaction.reply({
        content: "Please enter a valid channel name.",
        flags: MessageFlags.Ephemeral
      });
    }

    await channel.setName(safeName);

    await interaction.reply({
      content: `Ticket renamed to **${safeName}**.`,
      flags: MessageFlags.Ephemeral
    });

    await sendLog(
      interaction.guild,
      `Ticket renamed to ${safeName} by ${interaction.user}.`
    );

    return;
  }

  if (!/^\d{17,20}$/.test(value)) {
    return interaction.reply({
      content: "That does not look like a valid Discord user ID.",
      flags: MessageFlags.Ephemeral
    });
  }

  const member = await interaction.guild.members
    .fetch(value)
    .catch(() => null);

  if (!member) {
    return interaction.reply({
      content: "That member could not be found in this server.",
      flags: MessageFlags.Ephemeral
    });
  }

  if (interaction.customId.startsWith("ticket_add_modal")) {
    await channel.permissionOverwrites.edit(member.id, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true,
      AttachFiles: true,
      EmbedLinks: true
    });

    await interaction.reply({
      content: `${member} has been added to the ticket.`,
      flags: MessageFlags.Ephemeral
    });

    await sendLog(
      interaction.guild,
      `${member} was added to ${channel} by ${interaction.user}.`
    );

    return;
  }

  if (interaction.customId.startsWith("ticket_remove_modal")) {
    if (member.id === record.owner) {
      return interaction.reply({
        content: "The ticket owner cannot be removed from their own ticket.",
        flags: MessageFlags.Ephemeral
      });
    }

    if (member.id === interaction.guild.members.me.id) {
      return interaction.reply({
        content: "The bot cannot be removed from the ticket.",
        flags: MessageFlags.Ephemeral
      });
    }

    if (
      config.staffRole &&
      member.roles.cache.has(config.staffRole)
    ) {
      return interaction.reply({
        content: "A member of the configured support team cannot be removed using this option.",
        flags: MessageFlags.Ephemeral
      });
    }

    await channel.permissionOverwrites.delete(member.id);

    await interaction.reply({
      content: `${member} has been removed from the ticket.`,
      flags: MessageFlags.Ephemeral
    });

    await sendLog(
      interaction.guild,
      `${member} was removed from ${channel} by ${interaction.user}.`
    );

    return;
  }

  if (interaction.customId.startsWith("ticket_reassign_modal")) {
    if (
      !config.staffRole ||
      !member.roles.cache.has(config.staffRole)
    ) {
      return interaction.reply({
        content: "The selected member is not part of the configured support team.",
        flags: MessageFlags.Ephemeral
      });
    }

    record.claimedBy = member.id;
    config.ticketRecords[channel.id] = record;
    saveJSON(CONFIG_FILE, configs);

    await updateTicketEmbed(channel, record);

    await interaction.reply({
      content: `The ticket has been reassigned to ${member}.`,
      flags: MessageFlags.Ephemeral
    });

    await sendLog(
      interaction.guild,
      `${channel} was reassigned to ${member} by ${interaction.user}.`
    );
  }
}

// ==========================================
// CHANGE TICKET CATEGORY
// ==========================================

async function showCategoryMenu(interaction) {
  if (!(await checkSupportPermission(interaction))) return;

  const record = await getTicketRecord(interaction.channel);

  if (!record) {
    return interaction.reply({
      content: "This channel is not recognised as a ticket.",
      flags: MessageFlags.Ephemeral
    });
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`ticket_category_change:${interaction.channel.id}`)
    .setPlaceholder("Choose a new ticket category")
    .addOptions(
      Object.entries(TICKET_CATEGORIES).map(([value, category]) => ({
        label: category.label,
        value
      }))
    );

  await interaction.reply({
    content: "Select the new category for this ticket.",
    components: [
      new ActionRowBuilder().addComponents(menu)
    ],
    flags: MessageFlags.Ephemeral
  });
}

async function changeTicketCategory(interaction) {
  if (!(await checkSupportPermission(interaction))) return;

  const channelId = interaction.customId.split(":")[1];

  const channel = await interaction.guild.channels
    .fetch(channelId)
    .catch(() => null);

  if (!channel || channel.type !== ChannelType.GuildText) {
    return interaction.reply({
      content: "Ticket channel not found.",
      flags: MessageFlags.Ephemeral
    });
  }

  const config = getConfig(interaction.guild.id);
  const record = await getTicketRecord(channel);
  const categoryKey = interaction.values[0];

  if (!record || !TICKET_CATEGORIES[categoryKey]) {
    return interaction.reply({
      content: "The ticket category could not be updated.",
      flags: MessageFlags.Ephemeral
    });
  }

  record.category = categoryKey;
  config.ticketRecords[channel.id] = record;
  saveJSON(CONFIG_FILE, configs);

  const existingName = channel.name.replace(
    /^[a-z]+-/,
    ""
  );

  await channel.setName(
    `${categoryKey}-${existingName || "ticket"}`.slice(0, 100)
  );

  await updateTicketEmbed(channel, record);

  await interaction.update({
    content: `Ticket category changed to **${TICKET_CATEGORIES[categoryKey].label}**.`,
    components: []
  });

  await sendLog(
    interaction.guild,
    `${channel} category changed to ${TICKET_CATEGORIES[categoryKey].label} by ${interaction.user}.`
  );
}

// ==========================================
// TICKET INFORMATION
// ==========================================

async function showTicketInformation(interaction) {
  if (!(await checkSupportPermission(interaction))) return;

  const record = await getTicketRecord(interaction.channel);

  if (!record) {
    return interaction.reply({
      content: "This channel is not recognised as a ticket.",
      flags: MessageFlags.Ephemeral
    });
  }

  const category = TICKET_CATEGORIES[record.category];
  const openedAt = new Date(record.openedAt).getTime();

  return interaction.reply({
    embeds: [
      makeEmbed(
        "Ticket Information",
        [
          `Channel: ${interaction.channel}`,
          `Owner: <@${record.owner}>`,
          `Category: ${category?.label || "Unknown"}`,
          `Status: ${record.claimedBy ? "Claimed" : "Unclaimed"}`,
          `Assigned staff: ${record.claimedBy ? `<@${record.claimedBy}>` : "None"}`,
          `Opened: ${Number.isFinite(openedAt) ? `<t:${Math.floor(openedAt / 1000)}:F>` : "Unknown"}`
        ].join("\n")
      )
    ],
    flags: MessageFlags.Ephemeral
  });
}

// ==========================================
// SLASH COMMANDS
// ALL COMMANDS ADMINISTRATOR ONLY
// ==========================================

const commands = [
  new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Check the bot response time.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName("serverinfo")
    .setDescription("View information about the server.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName("userinfo")
    .setDescription("View information about a member.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption(option =>
      option.setName("member")
        .setDescription("The member to view.")
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("setup")
    .setDescription("Configure the ticket system.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addChannelOption(option =>
      option.setName("panel-channel")
        .setDescription("Channel where the ticket panel will be published.")
        .setRequired(true)
        .addChannelTypes(ChannelType.GuildText)
    )
    .addRoleOption(option =>
      option.setName("support-role")
        .setDescription("Role that can view and manage support tickets.")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("ai-setup")
    .setDescription("Configure the AI chat channel.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addChannelOption(option =>
      option.setName("channel")
        .setDescription("Channel where the AI chatbot will operate.")
        .setRequired(true)
        .addChannelTypes(ChannelType.GuildText)
    ),

  new SlashCommandBuilder()
    .setName("ai-status")
    .setDescription("View the AI chatbot status.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName("ai-toggle")
    .setDescription("Enable or disable the AI chatbot.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addBooleanOption(option =>
      option.setName("enabled")
        .setDescription("Whether the AI chatbot should be enabled.")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("warn")
    .setDescription("Issue a warning to a member.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
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
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption(option =>
      option.setName("member")
        .setDescription("Member to check.")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("clear-warnings")
    .setDescription("Clear a member's warnings.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption(option =>
      option.setName("member")
        .setDescription("Member whose warnings should be cleared.")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("timeout")
    .setDescription("Temporarily timeout a member.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
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
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption(option =>
      option.setName("member")
        .setDescription("Member to remove the timeout from.")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("kick")
    .setDescription("Remove a member from the server.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
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
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
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
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(option =>
      option.setName("user-id")
        .setDescription("Discord user ID.")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("purge")
    .setDescription("Delete multiple messages.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addIntegerOption(option =>
      option.setName("amount")
        .setDescription("Number of messages to delete.")
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(100)
    ),

  new SlashCommandBuilder()
    .setName("lockdown")
    .setDescription("Lock a channel against member messages.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addChannelOption(option =>
      option.setName("channel")
        .setDescription("Channel to lock. Defaults to this channel.")
        .addChannelTypes(ChannelType.GuildText)
    ),

  new SlashCommandBuilder()
    .setName("unlock")
    .setDescription("Unlock a channel.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
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

  const panelChannel = interaction.options.getChannel("panel-channel");
  const supportRole = interaction.options.getRole("support-role");

  if (supportRole.id === interaction.guild.roles.everyone.id) {
    return interaction.reply({
      content: "Please select a dedicated support role, not @everyone.",
      flags: MessageFlags.Ephemeral
    });
  }

  config.panelChannel = panelChannel.id;
  config.staffRole = supportRole.id;

  await interaction.deferReply({
    flags: MessageFlags.Ephemeral
  });

  try {
    const { ticketCategory, logsChannel } =
      await ensureTicketChannels(interaction.guild, config);

    const panelMessage = await publishTicketPanel(
      panelChannel,
      config
    );

    saveJSON(CONFIG_FILE, configs);

    await interaction.editReply({
      embeds: [
        makeEmbed(
          "Ticket System Configured",
          [
            `Panel channel: ${panelChannel}`,
            `Panel message: ${panelMessage.id}`,
            `Support role: ${supportRole}`,
            `Ticket category: ${ticketCategory}`,
            `Support logs: ${logsChannel}`,
            "",
            "The ticket system has been configured successfully."
          ].join("\n")
        )
      ]
    });

    await sendLog(
      interaction.guild,
      `Ticket system configured by ${interaction.user}.\nPanel: ${panelChannel}\nSupport role: ${supportRole}`
    );

  } catch (error) {
    console.error("Setup failed:", error);

    await interaction.editReply({
      content: "Setup failed. Check that the bot has Manage Channels, Manage Roles, View Channel, Send Messages, Embed Links and Read Message History permissions."
    });
  }
}

// ==========================================
// AI SETUP
// ==========================================

async function handleAISetup(interaction) {
  const config = getConfig(interaction.guild.id);
  const channel = interaction.options.getChannel("channel");

  config.aiChannel = channel.id;
  config.aiEnabled = true;

  saveJSON(CONFIG_FILE, configs);

  return interaction.reply({
    embeds: [
      makeEmbed(
        "AI Chat Configured",
        [
          `AI channel: ${channel}`,
          "AI chatbot: Enabled",
          "",
          "The AI chatbot will now respond to messages in the selected channel."
        ].join("\n")
      )
    ],
    flags: MessageFlags.Ephemeral
  });
}

// ==========================================
// AI STATUS AND TOGGLE
// ==========================================

async function handleAIStatus(interaction) {
  const config = getConfig(interaction.guild.id);

  return interaction.reply({
    embeds: [
      makeEmbed(
        "AI Chat Status",
        [
          `Channel: ${config.aiChannel ? `<#${config.aiChannel}>` : "Not configured"}`,
          `Status: ${config.aiEnabled ? "Enabled" : "Disabled"}`,
          `OpenAI connection: ${openai ? "API key configured" : "API key missing"}`,
          "Response limit: No bot-imposed limit",
          "Cooldown: Disabled"
        ].join("\n")
      )
    ],
    flags: MessageFlags.Ephemeral
  });
}

async function handleAIToggle(interaction) {
  const config = getConfig(interaction.guild.id);

  config.aiEnabled = interaction.options.getBoolean("enabled");

  saveJSON(CONFIG_FILE, configs);

  return interaction.reply({
    embeds: [
      makeEmbed(
        "AI Chat Updated",
        `The AI chatbot has been ${config.aiEnabled ? "enabled" : "disabled"}.`
      )
    ],
    flags: MessageFlags.Ephemeral
  });
}

// ==========================================
// AI CHAT
// NO ARTIFICIAL RESPONSE COUNT OR COOLDOWN
// ==========================================

const aiConversations = new Map();
const aiQueues = new Map();

const AI_SYSTEM_PROMPT = `
You are Safeguarding Assistant, the AI chatbot for The Safeguarding Network.

The Safeguarding Network is an independent online community. It is not an official safeguarding authority, emergency service or professional counselling service.

Your responsibilities:
- Provide clear, friendly and general information.
- Explain general safeguarding and online safety concepts.
- Encourage people to speak to an appropriate trusted adult or qualified professional when necessary.
- Be respectful, calm and non-judgemental.
- Protect people's privacy.

Important boundaries:
- Do not claim to be a professional safeguarding worker.
- Do not diagnose people or make professional assessments.
- Do not promise confidentiality.
- Do not claim that you have reported or escalated a concern.
- Do not request passwords, addresses, phone numbers or unnecessary identifying information.
- Do not encourage anyone to investigate a concern themselves or confront someone they are worried about.
- Do not provide instructions for harmful, illegal or dangerous activities.
- Do not provide graphic descriptions of violence, abuse or self-harm.
- If someone describes immediate danger in the UK, tell them to call 999.
- For non-emergency concerns, encourage them to contact an appropriate trusted adult or professional service.
- Make it clear that this chatbot is not a replacement for real-world support.

Keep replies reasonably concise and easy to understand.
`;

function splitAIResponse(text, maxLength = 1900) {
  const chunks = [];

  while (text.length > maxLength) {
    let splitAt = text.lastIndexOf("\n", maxLength);

    if (splitAt < maxLength * 0.5) {
      splitAt = text.lastIndexOf(" ", maxLength);
    }

    if (splitAt < maxLength * 0.5) {
      splitAt = maxLength;
    }

    chunks.push(text.slice(0, splitAt).trim());
    text = text.slice(splitAt).trim();
  }

  if (text.length > 0) {
    chunks.push(text);
  }

  return chunks;
}

async function processAIMessage(message) {
  if (message.author.bot || !message.guild) return;

  const config = getConfig(message.guild.id);

  if (
    !config.aiEnabled ||
    !config.aiChannel ||
    message.channel.id !== config.aiChannel
  ) {
    return;
  }

  if (!openai) {
    await message.reply(
      "The AI service is not currently configured. Please contact a server administrator."
    );
    return;
  }

  const conversationKey =
    `${message.guild.id}:${message.author.id}`;

  if (!aiConversations.has(conversationKey)) {
    aiConversations.set(conversationKey, []);
  }

  const history = aiConversations.get(conversationKey);

  history.push({
    role: "user",
    content: message.content.slice(0, 6000)
  });

  // Retain recent context without imposing a response-count limit.
  if (history.length > 20) {
    history.splice(0, history.length - 20);
  }

  await message.channel.sendTyping();

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        {
          role: "system",
          content: AI_SYSTEM_PROMPT
        },
        ...history
      ],
      max_completion_tokens: 2000
    });

    const answer =
      response.choices[0]?.message?.content?.trim();

    if (!answer) {
      throw new Error("OpenAI returned an empty response.");
    }

    history.push({
      role: "assistant",
      content: answer
    });

    if (history.length > 20) {
      history.splice(0, history.length - 20);
    }

    const chunks = splitAIResponse(answer);

    for (let i = 0; i < chunks.length; i++) {
      if (i === 0) {
        await message.reply({
          content: chunks[i],
          allowedMentions: {
            parse: []
          }
        });
      } else {
        await message.channel.send({
          content: chunks[i],
          allowedMentions: {
            parse: []
          }
        });
      }
    }

  } catch (error) {
    console.error("AI RESPONSE ERROR:", error);
    console.error("OpenAI error status:", error.status || "Unknown");
    console.error("OpenAI error code:", error.code || "Unknown");

    await message.reply(
      "I'm having trouble responding at the moment. Please try again later."
    ).catch(console.error);
  }
}

async function handleAIMessage(message) {
  if (message.author.bot || !message.guild) return;

  const config = getConfig(message.guild.id);

  if (
    !config.aiEnabled ||
    !config.aiChannel ||
    message.channel.id !== config.aiChannel
  ) {
    return;
  }

  const queueKey =
    `${message.guild.id}:${message.author.id}`;

  const previousTask =
    aiQueues.get(queueKey) || Promise.resolve();

  const currentTask = previousTask
    .catch(() => {})
    .then(() => processAIMessage(message));

  aiQueues.set(queueKey, currentTask);

  try {
    await currentTask;
  } finally {
    if (aiQueues.get(queueKey) === currentTask) {
      aiQueues.delete(queueKey);
    }
  }
}

// ==========================================
// COMMAND HANDLER
// ==========================================

async function handleCommand(interaction) {
  const { commandName, guild } = interaction;

  if (!isAdmin(interaction)) {
    return interaction.reply({
      content: "Only server administrators can use slash commands.",
      flags: MessageFlags.Ephemeral
    });
  }

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

  if (commandName === "ai-setup") {
    return handleAISetup(interaction);
  }

  if (commandName === "ai-status") {
    return handleAIStatus(interaction);
  }

  if (commandName === "ai-toggle") {
    return handleAIToggle(interaction);
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

    if (interaction.isButton()) {
      switch (interaction.customId) {
        case "ticket_claim":
          return await claimTicket(interaction);

        case "ticket_close":
          return await requestTicketClose(interaction);

        case "ticket_close_confirm":
          return await finishTicketClose(interaction);

        case "ticket_close_cancel":
          return await interaction.update({
            content: "Ticket closing cancelled.",
            embeds: [],
            components: []
          });

        case "ticket_modpanel":
          return await openModPanel(interaction);

        case "ticket_rename":
          return await showTicketModal(interaction, "rename");

        case "ticket_add_member":
          return await showTicketModal(interaction, "add");

        case "ticket_remove_member":
          return await showTicketModal(interaction, "remove");

        case "ticket_reassign":
          return await showTicketModal(interaction, "reassign");

        case "ticket_change_category":
          return await showCategoryMenu(interaction);

        case "ticket_information":
          return await showTicketInformation(interaction);
      }
    }

    if (
      interaction.isStringSelectMenu() &&
      interaction.customId.startsWith("ticket_category_change:")
    ) {
      return await changeTicketCategory(interaction);
    }

    if (
      interaction.isModalSubmit() &&
      (
        interaction.customId.startsWith("ticket_rename_modal:") ||
        interaction.customId.startsWith("ticket_add_modal:") ||
        interaction.customId.startsWith("ticket_remove_modal:") ||
        interaction.customId.startsWith("ticket_reassign_modal:")
      )
    ) {
      return await handleTicketModal(interaction);
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
// AI MESSAGE EVENT
// ==========================================

client.on("messageCreate", async message => {
  try {
    await handleAIMessage(message);
  } catch (error) {
    console.error("AI message handler error:", error);
  }
});

// ==========================================
// READY EVENT
// ==========================================

client.once("clientReady", readyClient => {
  console.log("------------------------------------");
  console.log("Safeguarding Assistant is online.");
  console.log(`Logged in as: ${readyClient.user.tag}`);
  console.log(`Bot ID: ${readyClient.user.id}`);

  if (readyClient.user.id !== CLIENT_ID) {
    console.error("WARNING: DISCORD_CLIENT_ID does not match the logged-in bot ID.");
    console.error("Check the DISCORD_CLIENT_ID environment variable.");
  }

  console.log("------------------------------------");
});

// ==========================================
// STARTUP AND SLASH COMMAND REGISTRATION
// ==========================================

async function startBot() {
  console.log("------------------------------------");
  console.log("Safeguarding Assistant starting...");
  console.log("------------------------------------");

  console.log(`Application ID: ${CLIENT_ID}`);
  console.log(`Server ID: ${GUILD_ID}`);
  console.log(`Commands prepared: ${commands.length}`);
  console.log(`OpenAI configured: ${openai ? "Yes" : "No"}`);

  try {
    const rest = new REST({ version: "10" }).setToken(TOKEN);

    console.log("Registering slash commands with Discord...");

    const registeredCommands = await rest.put(
      Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
      {
        body: commands
      }
    );

    console.log("------------------------------------");
    console.log("COMMAND REGISTRATION SUCCESSFUL");
    console.log(`Discord confirmed: ${registeredCommands.length} commands`);

    registeredCommands.forEach(command => {
      console.log(`Registered: /${command.name}`);
    });

    console.log("------------------------------------");

  } catch (error) {
    console.error("------------------------------------");
    console.error("SLASH COMMAND REGISTRATION FAILED");
    console.error("Error code:", error.code || "Unknown");
    console.error("Error message:", error.message);
    console.error("------------------------------------");
  }

  console.log("Connecting to Discord...");

  await client.login(TOKEN);
}

// ==========================================
// START
// ==========================================

startBot().catch(error => {
  console.error("Bot startup failed:", error);
  process.exitCode = 1;
});
