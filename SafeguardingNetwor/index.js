require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");

const {
    Client,
    GatewayIntentBits,
    Partials,
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
    AttachmentBuilder
} = require("discord.js");

// ======================================================
// CONFIGURATION
// ======================================================

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID || process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID || process.env.DISCORD_GUILD_ID;

const DEFAULT_COLOUR = 0x2F6146;
const WEBHOOK_NAME = "Pub Bot Webhooks";
const TICKET_STAFF_ROLE_ID = "1566481343645483181";

if (!TOKEN || !CLIENT_ID) {
    console.error("Missing DISCORD_TOKEN or CLIENT_ID.");
    process.exit(1);
}

// ======================================================
// CLIENT
// ======================================================

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ],
    partials: [
        Partials.Channel,
        Partials.Message
    ]
});

// ======================================================
// DATABASE
// ======================================================

const DATA_DIRECTORY = path.join(__dirname, "data");
const DATABASE_FILE = path.join(DATA_DIRECTORY, "guild-data.json");

if (!fs.existsSync(DATA_DIRECTORY)) {
    fs.mkdirSync(DATA_DIRECTORY, { recursive: true });
}

function loadDatabase() {
    try {
        if (!fs.existsSync(DATABASE_FILE)) {
            return {};
        }

        return JSON.parse(fs.readFileSync(DATABASE_FILE, "utf8"));
    } catch (error) {
        console.error("Database loading error:", error);
        return {};
    }
}

const database = loadDatabase();

function saveDatabase() {
    fs.writeFileSync(
        DATABASE_FILE,
        JSON.stringify(database, null, 2)
    );
}

function getGuildData(guildId) {
    if (!database[guildId]) {
        database[guildId] = {
            reviewChannel: null,
            ticketPanelChannel: null,
            ticketLogChannel: null,
            staffRole: TICKET_STAFF_ROLE_ID,
            ticketCategories: {
                general: null,
                staff: null,
                other: null
            },
            tickets: {},
            reviews: [],
            shifts: {},
            events: []
        };
    }

    const data = database[guildId];

    data.ticketCategories ??= {
        general: null,
        staff: null,
        other: null
    };

    data.tickets ??= {};
    data.reviews ??= [];
    data.shifts ??= {};
    data.events ??= [];

    return data;
}

// ======================================================
// GENERAL HELPERS
// ======================================================

function makeEmbed(title, description, colour = DEFAULT_COLOUR) {
    return new EmbedBuilder()
        .setColor(colour)
        .setTitle(title)
        .setDescription(description)
        .setTimestamp();
}

function parseColour(value) {
    if (!value) return DEFAULT_COLOUR;

    const cleaned = value.replace("#", "");

    if (!/^[0-9A-Fa-f]{6}$/.test(cleaned)) {
        return null;
    }

    return parseInt(cleaned, 16);
}

function isStaff(member, data) {
    return (
        member.permissions.has(PermissionFlagsBits.Administrator) ||
        member.permissions.has(PermissionFlagsBits.ManageGuild) ||
        (data.staffRole && member.roles.cache.has(data.staffRole))
    );
}

async function getTextChannel(guild, channelId) {
    if (!channelId) return null;

    try {
        const channel = await guild.channels.fetch(channelId);

        if (!channel || !channel.isTextBased() || channel.isDMBased()) {
            return null;
        }

        return channel;
    } catch {
        return null;
    }
}

async function getWebhook(channel) {
    if (!channel || !channel.isTextBased()) {
        throw new Error("The selected channel is not a text channel.");
    }

    const permissions = channel.permissionsFor(client.user);

    if (!permissions?.has(PermissionFlagsBits.ManageWebhooks)) {
        throw new Error(
            `I need the Manage Webhooks permission in #${channel.name}.`
        );
    }

    const webhooks = await channel.fetchWebhooks();

    let webhook = webhooks.find(
        hook => hook.name === WEBHOOK_NAME && hook.owner?.id === client.user.id
    );

    if (!webhook) {
        webhook = await channel.createWebhook({
            name: WEBHOOK_NAME
        });
    }

    return webhook;
}

async function sendWebhookEmbed(channel, embed, options = {}) {
    const webhook = await getWebhook(channel);

    return webhook.send({
        username: options.username || "Pub Bot",
        embeds: [embed],
        allowedMentions: {
            parse: []
        }
    });
}

async function replyPrivate(interaction, content) {
    const payload = {
        content,
        flags: MessageFlags.Ephemeral
    };

    if (interaction.replied || interaction.deferred) {
        return interaction.followUp(payload);
    }

    return interaction.reply(payload);
}

function getOptionChannel(interaction, name) {
    return interaction.options.getChannel(name);
}

// ======================================================
// SLASH COMMANDS
// ======================================================

const commands = [

    // SETUP
    new SlashCommandBuilder()
        .setName("setup")
        .setDescription("Configure the pub Discord bot.")
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addChannelOption(option =>
            option.setName("review_channel")
                .setDescription("Channel where customer reviews are published.")
                .addChannelTypes(ChannelType.GuildText)
        )
        .addChannelOption(option =>
            option.setName("ticket_panel_channel")
                .setDescription("Channel where the ticket panel is posted.")
                .addChannelTypes(ChannelType.GuildText)
        )
        .addChannelOption(option =>
            option.setName("ticket_log_channel")
                .setDescription("Channel where ticket transcripts are sent.")
                .addChannelTypes(ChannelType.GuildText)
        )
        .addRoleOption(option =>
            option.setName("staff_role")
                .setDescription("Role that can access staff tickets.")
        )
        .addChannelOption(option =>
            option.setName("general_category")
                .setDescription("Discord category for General Enquiries tickets.")
                .addChannelTypes(ChannelType.GuildCategory)
        )
        .addChannelOption(option =>
            option.setName("staff_category")
                .setDescription("Discord category for Staff Support tickets.")
                .addChannelTypes(ChannelType.GuildCategory)
        )
        .addChannelOption(option =>
            option.setName("other_category")
                .setDescription("Discord category for Other Enquiries tickets.")
                .addChannelTypes(ChannelType.GuildCategory)
        )
        .addBooleanOption(option =>
            option.setName("post_ticket_panel")
                .setDescription("Post the ticket panel after saving settings.")
        ),

    // CUSTOM EMBED
    new SlashCommandBuilder()
        .setName("embed")
        .setDescription("Create and send a customised webhook embed.")
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
        .addChannelOption(option =>
            option.setName("channel")
                .setDescription("Where the embed should be sent.")
                .setRequired(true)
                .addChannelTypes(ChannelType.GuildText)
        )
        .addStringOption(option =>
            option.setName("title")
                .setDescription("Embed title.")
                .setRequired(true)
        )
        .addStringOption(option =>
            option.setName("description")
                .setDescription("Embed description.")
                .setRequired(true)
        )
        .addStringOption(option =>
            option.setName("colour")
                .setDescription("Hex colour, such as 2F6146.")
        )
        .addStringOption(option =>
            option.setName("image")
                .setDescription("Image URL.")
        )
        .addStringOption(option =>
            option.setName("thumbnail")
                .setDescription("Thumbnail URL.")
        )
        .addStringOption(option =>
            option.setName("footer")
                .setDescription("Embed footer.")
        )
        .addStringOption(option =>
            option.setName("author")
                .setDescription("Embed author.")
        )
        .addStringOption(option =>
            option.setName("webhook_name")
                .setDescription("Name displayed as the webhook sender.")
        ),

    // ANNOUNCEMENTS
    new SlashCommandBuilder()
        .setName("announce")
        .setDescription("Send a public announcement.")
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
        .addChannelOption(option =>
            option.setName("channel")
                .setDescription("Announcement channel.")
                .setRequired(true)
                .addChannelTypes(ChannelType.GuildText)
        )
        .addStringOption(option =>
            option.setName("title")
                .setDescription("Announcement title.")
                .setRequired(true)
        )
        .addStringOption(option =>
            option.setName("message")
                .setDescription("Announcement message.")
                .setRequired(true)
        )
        .addStringOption(option =>
            option.setName("image")
                .setDescription("Optional image URL.")
        ),

    // CUSTOMER REVIEWS
    new SlashCommandBuilder()
        .setName("review")
        .setDescription("Submit a customer review.")
        .addIntegerOption(option =>
            option.setName("rating")
                .setDescription("Your rating from 1 to 5.")
                .setRequired(true)
                .setMinValue(1)
                .setMaxValue(5)
        )
        .addStringOption(option =>
            option.setName("review")
                .setDescription("Tell us about your experience.")
                .setRequired(true)
                .setMaxLength(1500)
        ),

    // SHIFT MANAGEMENT
    new SlashCommandBuilder()
        .setName("shift-management")
        .setDescription("Manage staff shifts.")
        .addStringOption(option =>
            option.setName("action")
                .setDescription("Choose a shift action.")
                .setRequired(true)
                .addChoices(
                    { name: "Start shift", value: "start" },
                    { name: "End shift", value: "end" },
                    { name: "View active shifts", value: "active" }
                )
        ),

    // STAFF ANNOUNCEMENT
    new SlashCommandBuilder()
        .setName("staff-announcement")
        .setDescription("Send an announcement to staff.")
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
        .addChannelOption(option =>
            option.setName("channel")
                .setDescription("Staff announcement channel.")
                .setRequired(true)
                .addChannelTypes(ChannelType.GuildText)
        )
        .addStringOption(option =>
            option.setName("title")
                .setDescription("Announcement title.")
                .setRequired(true)
        )
        .addStringOption(option =>
            option.setName("message")
                .setDescription("Announcement message.")
                .setRequired(true)
        ),

    // STAFF MANAGEMENT
    new SlashCommandBuilder()
        .setName("staff-manage")
        .setDescription("Manage a member's staff role.")
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
        .addStringOption(option =>
            option.setName("action")
                .setDescription("Choose an action.")
                .setRequired(true)
                .addChoices(
                    { name: "Add staff role", value: "add" },
                    { name: "Remove staff role", value: "remove" }
                )
        )
        .addUserOption(option =>
            option.setName("member")
                .setDescription("Member to manage.")
                .setRequired(true)
        )
        .addRoleOption(option =>
            option.setName("role")
                .setDescription("Staff role to add or remove.")
                .setRequired(true)
        ),

    // EVENT CREATION
    new SlashCommandBuilder()
        .setName("event-create")
        .setDescription("Create a pub event announcement.")
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageEvents)
        .addChannelOption(option =>
            option.setName("channel")
                .setDescription("Channel where the event is announced.")
                .setRequired(true)
                .addChannelTypes(ChannelType.GuildText)
        )
        .addStringOption(option =>
            option.setName("name")
                .setDescription("Event name.")
                .setRequired(true)
        )
        .addStringOption(option =>
            option.setName("details")
                .setDescription("Event information.")
                .setRequired(true)
        )
        .addStringOption(option =>
            option.setName("date")
                .setDescription("Event date and time.")
                .setRequired(true)
        )
];

async function registerCommands() {
    const rest = new REST({ version: "10" }).setToken(TOKEN);

    const body = commands.map(command => command.toJSON());

    if (GUILD_ID) {
        await rest.put(
            Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
            { body }
        );

        console.log(`Registered ${body.length} guild commands.`);
    } else {
        await rest.put(
            Routes.applicationCommands(CLIENT_ID),
            { body }
        );

        console.log(`Registered ${body.length} global commands.`);
    }
}

// ======================================================
// TICKET PANEL
// ======================================================

function createTicketPanel() {
    const embed = makeEmbed(
        "Customer Support",
        [
            "Welcome to our support centre.",
            "",
            "If you need assistance, please select the option below that best describes your enquiry.",
            "",
            "**General Enquiries**",
            "For general questions, information and assistance.",
            "",
            "**Staff Support**",
            "For existing members of staff who require assistance.",
            "",
            "**Other Enquiries**",
            "For anything that does not fit the other categories.",
            "",
            "A private ticket will be created and the appropriate staff members will be notified.",
            "",
            "Please provide as much information as possible when opening your ticket."
        ].join("\n")
    );

    const menu = new StringSelectMenuBuilder()
        .setCustomId("ticket_category")
        .setPlaceholder("Select a support category")
        .addOptions(
            {
                label: "General Enquiries",
                description: "Questions and general assistance.",
                value: "general"
            },
            {
                label: "Staff Support",
                description: "Support for existing staff members.",
                value: "staff"
            },
            {
                label: "Other Enquiries",
                description: "Anything else you need assistance with.",
                value: "other"
            }
        );

    return {
        embeds: [embed],
        components: [
            new ActionRowBuilder().addComponents(menu)
        ]
    };
}

async function createTicket(interaction, type) {
    const data = getGuildData(interaction.guildId);

    const existingTicket = Object.values(data.tickets).find(
        ticket =>
            ticket.userId === interaction.user.id &&
            ticket.status === "open"
    );

    if (existingTicket) {
        const existingChannel = await interaction.guild.channels.fetch(
            existingTicket.channelId
        ).catch(() => null);

        if (existingChannel) {
            return replyPrivate(
                interaction,
                `You already have an open ticket: ${existingChannel}`
            );
        }

        existingTicket.status = "closed";
        saveDatabase();
    }

    const categoryNames = {
        general: "General Enquiries",
        staff: "Staff Support",
        other: "Other Enquiries"
    };

    const categoryIds = data.ticketCategories;
    const categoryId = categoryIds[type];

    if (!categoryId) {
        return replyPrivate(
            interaction,
            "This ticket category has not been configured yet. Please contact a member of staff."
        );
    }

    const category = await interaction.guild.channels.fetch(categoryId)
        .catch(() => null);

    if (!category || category.type !== ChannelType.GuildCategory) {
        return replyPrivate(
            interaction,
            "The configured ticket category could not be found. Please contact an administrator."
        );
    }

    const staffRoleId = data.staffRole || TICKET_STAFF_ROLE_ID;

    const permissionOverwrites = [
        {
            id: interaction.guild.roles.everyone.id,
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
            id: client.user.id,
            allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ReadMessageHistory,
                PermissionFlagsBits.ManageChannels,
                PermissionFlagsBits.AttachFiles,
                PermissionFlagsBits.EmbedLinks
            ]
        }
    ];

    if (staffRoleId && interaction.guild.roles.cache.has(staffRoleId)) {
        permissionOverwrites.push({
            id: staffRoleId,
            allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ReadMessageHistory
            ]
        });
    }

    const safeName = interaction.user.username
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "-")
        .slice(0, 20);

    const channel = await interaction.guild.channels.create({
        name: `${type}-${safeName}`,
        type: ChannelType.GuildText,
        parent: category.id,
        permissionOverwrites,
        topic: `${categoryNames[type]} ticket opened by ${interaction.user.tag}`
    });

    data.tickets[channel.id] = {
        channelId: channel.id,
        userId: interaction.user.id,
        type,
        status: "open",
        openedAt: new Date().toISOString()
    };

    saveDatabase();

    const ticketDescriptions = {
        general: "Thank you for opening a General Enquiries ticket. Please explain your question or enquiry below. A member of our team will assist you as soon as possible.",
        staff: "Thank you for opening a Staff Support ticket. This channel is reserved for existing staff members who require assistance. Please explain what you need help with.",
        other: "Thank you for contacting us. Please explain the nature of your enquiry below so the appropriate team member can assist you."
    };

    const embed = makeEmbed(
        categoryNames[type],
        ticketDescriptions[type]
    );

    embed.addFields(
        {
            name: "Opened by",
            value: `${interaction.user}`,
            inline: true
        },
        {
            name: "Ticket category",
            value: categoryNames[type],
            inline: true
        }
    );

    const closeButton = new ButtonBuilder()
        .setCustomId("close_ticket")
        .setLabel("Close Ticket")
        .setStyle(ButtonStyle.Danger);

    await channel.send({
        content: `${interaction.user} <@${staffRoleId}>`,
        embeds: [embed],
        components: [
            new ActionRowBuilder().addComponents(closeButton)
        ],
        allowedMentions: {
            users: [interaction.user.id],
            roles: staffRoleId ? [staffRoleId] : []
        }
    });

    return replyPrivate(
        interaction,
        `Your ${categoryNames[type]} ticket has been created: ${channel}`
    );
}

// ======================================================
// TICKET TRANSCRIPTS
// ======================================================

async function createTranscript(channel) {
    const messages = await channel.messages.fetch({
        limit: 100
    });

    const sortedMessages = [...messages.values()].sort(
        (a, b) => a.createdTimestamp - b.createdTimestamp
    );

    const transcript = sortedMessages.map(message => {
        const timestamp = new Date(message.createdTimestamp).toISOString();

        const attachments = [...message.attachments.values()]
            .map(file => file.url)
            .join(", ");

        return [
            `[${timestamp}] ${message.author.tag}:`,
            message.content || "[No text content]",
            attachments ? `Attachments: ${attachments}` : ""
        ].filter(Boolean).join("\n");
    }).join("\n\n");

    return Buffer.from(
        transcript || "No messages were recorded.",
        "utf8"
    );
}

async function closeTicket(interaction) {
    const data = getGuildData(interaction.guildId);
    const ticket = data.tickets[interaction.channelId];

    if (!ticket || ticket.status !== "open") {
        return replyPrivate(
            interaction,
            "This channel is not an open ticket."
        );
    }

    const canClose =
        interaction.user.id === ticket.userId ||
        isStaff(interaction.member, data);

    if (!canClose) {
        return replyPrivate(
            interaction,
            "You do not have permission to close this ticket."
        );
    }

    await interaction.deferReply({
        flags: MessageFlags.Ephemeral
    });

    const transcriptBuffer = await createTranscript(interaction.channel);

    const transcriptFile = new AttachmentBuilder(
        transcriptBuffer,
        {
            name: `transcript-${interaction.channel.id}.txt`
        }
    );

    const logChannel = await getTextChannel(
        interaction.guild,
        data.ticketLogChannel
    );

    if (logChannel) {
        const logEmbed = makeEmbed(
            "Ticket Closed",
            "A support ticket has been closed."
        );

        logEmbed.addFields(
            {
                name: "Ticket",
                value: interaction.channel.name,
                inline: true
            },
            {
                name: "Opened by",
                value: `<@${ticket.userId}>`,
                inline: true
            },
            {
                name: "Closed by",
                value: `${interaction.user}`,
                inline: true
            }
        );

        await logChannel.send({
            embeds: [logEmbed],
            files: [transcriptFile]
        });
    }

    ticket.status = "closed";
    ticket.closedAt = new Date().toISOString();
    ticket.closedBy = interaction.user.id;

    saveDatabase();

    await interaction.editReply({
        content: "The ticket has been closed and its transcript has been recorded."
    });

    await interaction.channel.send({
        embeds: [
            makeEmbed(
                "Ticket Closed",
                `This ticket was closed by ${interaction.user}.`
            )
        ]
    });

    setTimeout(async () => {
        await interaction.channel.delete("Ticket closed").catch(() => null);
    }, 5000);
}

// ======================================================
// SLASH COMMAND HANDLER
// ======================================================

client.on("interactionCreate", async interaction => {
    try {

        // ------------------------------
        // TICKET CATEGORY SELECTOR
        // ------------------------------

        if (
            interaction.isStringSelectMenu() &&
            interaction.customId === "ticket_category"
        ) {
            return createTicket(
                interaction,
                interaction.values[0]
            );
        }

        // ------------------------------
        // TICKET CLOSE BUTTON
        // ------------------------------

        if (
            interaction.isButton() &&
            interaction.customId === "close_ticket"
        ) {
            return closeTicket(interaction);
        }

        if (!interaction.isChatInputCommand()) {
            return;
        }

        const data = getGuildData(interaction.guildId);

        // ==================================================
        // /SETUP
        // ==================================================

        if (interaction.commandName === "setup") {
            const reviewChannel = getOptionChannel(interaction, "review_channel");
            const panelChannel = getOptionChannel(interaction, "ticket_panel_channel");
            const logChannel = getOptionChannel(interaction, "ticket_log_channel");
            const staffRole = interaction.options.getRole("staff_role");

            const generalCategory = getOptionChannel(interaction, "general_category");
            const staffCategory = getOptionChannel(interaction, "staff_category");
            const otherCategory = getOptionChannel(interaction, "other_category");

            if (reviewChannel) {
                data.reviewChannel = reviewChannel.id;
            }

            if (panelChannel) {
                data.ticketPanelChannel = panelChannel.id;
            }

            if (logChannel) {
                data.ticketLogChannel = logChannel.id;
            }

            if (staffRole) {
                data.staffRole = staffRole.id;
            }

            if (generalCategory) {
                data.ticketCategories.general = generalCategory.id;
            }

            if (staffCategory) {
                data.ticketCategories.staff = staffCategory.id;
            }

            if (otherCategory) {
                data.ticketCategories.other = otherCategory.id;
            }

            saveDatabase();

            const shouldPostPanel = interaction.options.getBoolean(
                "post_ticket_panel"
            );

            let panelResult = "";

            if (shouldPostPanel) {
                const destination = await getTextChannel(
                    interaction.guild,
                    data.ticketPanelChannel
                );

                if (!destination) {
                    return replyPrivate(
                        interaction,
                        "Settings were saved, but the ticket panel could not be posted. Configure a valid ticket panel channel first."
                    );
                }

                await destination.send(createTicketPanel());

                panelResult = `\nTicket panel posted in ${destination}.`;
            }

            const setupEmbed = makeEmbed(
                "Bot Configuration Updated",
                [
                    `Review channel: ${data.reviewChannel ? `<#${data.reviewChannel}>` : "Not configured"}`,
                    `Ticket panel: ${data.ticketPanelChannel ? `<#${data.ticketPanelChannel}>` : "Not configured"}`,
                    `Transcript channel: ${data.ticketLogChannel ? `<#${data.ticketLogChannel}>` : "Not configured"}`,
                    `Staff role: ${data.staffRole ? `<@&${data.staffRole}>` : "Not configured"}`,
                    "",
                    `General Enquiries: ${data.ticketCategories.general ? `<#${data.ticketCategories.general}>` : "Not configured"}`,
                    `Staff Support: ${data.ticketCategories.staff ? `<#${data.ticketCategories.staff}>` : "Not configured"}`,
                    `Other Enquiries: ${data.ticketCategories.other ? `<#${data.ticketCategories.other}>` : "Not configured"}`,
                    panelResult
                ].join("\n")
            );

            return interaction.reply({
                embeds: [setupEmbed],
                flags: MessageFlags.Ephemeral
            });
        }

        // ==================================================
        // /EMBED
        // ==================================================

        if (interaction.commandName === "embed") {
            const channel = getOptionChannel(interaction, "channel");
            const title = interaction.options.getString("title");
            const description = interaction.options.getString("description");

            const colourInput = interaction.options.getString("colour");
            const image = interaction.options.getString("image");
            const thumbnail = interaction.options.getString("thumbnail");
            const footer = interaction.options.getString("footer");
            const author = interaction.options.getString("author");
            const webhookName = interaction.options.getString("webhook_name");

            const colour = parseColour(colourInput);

            if (colour === null) {
                return replyPrivate(
                    interaction,
                    "That colour is invalid. Please use a six-character hex colour, such as 2F6146."
                );
            }

            const embed = new EmbedBuilder()
                .setColor(colour)
                .setTitle(title)
                .setDescription(description)
                .setTimestamp();

            if (image) embed.setImage(image);
            if (thumbnail) embed.setThumbnail(thumbnail);
            if (footer) embed.setFooter({ text: footer });
            if (author) embed.setAuthor({ name: author });

            await interaction.deferReply({
                flags: MessageFlags.Ephemeral
            });

            try {
                await sendWebhookEmbed(channel, embed, {
                    username: webhookName || "Pub Bot"
                });

                return interaction.editReply({
                    content: `Your embed has been sent to ${channel}.`
                });
            } catch (error) {
                console.error("Embed webhook error:", error);

                return interaction.editReply({
                    content: `The embed could not be sent: ${error.message}`
                });
            }
        }

        // ==================================================
        // /ANNOUNCE
        // ==================================================

        if (interaction.commandName === "announce") {
            const channel = getOptionChannel(interaction, "channel");
            const title = interaction.options.getString("title");
            const message = interaction.options.getString("message");
            const image = interaction.options.getString("image");

            const embed = makeEmbed(title, message);

            if (image) {
                embed.setImage(image);
            }

            await interaction.deferReply({
                flags: MessageFlags.Ephemeral
            });

            try {
                await sendWebhookEmbed(channel, embed, {
                    username: "Pub Announcements"
                });

                return interaction.editReply({
                    content: `Your announcement has been sent to ${channel}.`
                });
            } catch (error) {
                console.error("Announcement error:", error);

                return interaction.editReply({
                    content: `The announcement could not be sent: ${error.message}`
                });
            }
        }

        // ==================================================
        // /REVIEW
        // ==================================================

        if (interaction.commandName === "review") {
            const rating = interaction.options.getInteger("rating");
            const reviewText = interaction.options.getString("review");

            const reviewChannel = await getTextChannel(
                interaction.guild,
                data.reviewChannel
            );

            if (!reviewChannel) {
                return replyPrivate(
                    interaction,
                    "The review channel has not been configured. Please contact a member of staff."
                );
            }

            const ratingText = `${rating}/5`;

            const embed = makeEmbed(
                "Customer Review",
                reviewText
            );

            embed.addFields(
                {
                    name: "Rating",
                    value: ratingText,
                    inline: true
                },
                {
                    name: "Customer",
                    value: `${interaction.user}`,
                    inline: true
                }
            );

            embed.setFooter({
                text: `Review submitted by ${interaction.user.tag}`
            });

            await interaction.deferReply({
                flags: MessageFlags.Ephemeral
            });

            try {
                await sendWebhookEmbed(
                    reviewChannel,
                    embed,
                    {
                        username: "Customer Reviews"
                    }
                );

                return interaction.editReply({
                    content: "Thank you for submitting your review. Your feedback has been published."
                });
            } catch (error) {
                console.error("Review publishing error:", error);

                return interaction.editReply({
                    content: `Your review could not be published. Please contact a member of staff. Error: ${error.message}`
                });
            }
        }

        // ==================================================
        // /SHIFT-MANAGEMENT
        // ==================================================

        if (interaction.commandName === "shift-management") {
            if (!isStaff(interaction.member, data)) {
                return replyPrivate(
                    interaction,
                    "You must have the configured staff role to manage shifts."
                );
            }

            const action = interaction.options.getString("action");
            const userId = interaction.user.id;

            if (action === "start") {
                if (data.shifts[userId]?.active) {
                    return replyPrivate(
                        interaction,
                        "You already have an active shift."
                    );
                }

                data.shifts[userId] = {
                    active: true,
                    startedAt: new Date().toISOString()
                };

                saveDatabase();

                return replyPrivate(
                    interaction,
                    "Your staff shift has started."
                );
            }

            if (action === "end") {
                const shift = data.shifts[userId];

                if (!shift?.active) {
                    return replyPrivate(
                        interaction,
                        "You do not currently have an active shift."
                    );
                }

                const startedAt = new Date(shift.startedAt);
                const endedAt = new Date();
                const duration = endedAt - startedAt;

                shift.active = false;
                shift.endedAt = endedAt.toISOString();
                shift.durationMs = duration;

                saveDatabase();

                const totalMinutes = Math.floor(duration / 60000);
                const hours = Math.floor(totalMinutes / 60);
                const minutes = totalMinutes % 60;

                return replyPrivate(
                    interaction,
                    `Your shift has ended. Duration: ${hours} hours and ${minutes} minutes.`
                );
            }

            if (action === "active") {
                const activeShifts = Object.entries(data.shifts)
                    .filter(([, shift]) => shift.active);

                if (!activeShifts.length) {
                    return replyPrivate(
                        interaction,
                        "There are currently no active staff shifts."
                    );
                }

                const description = activeShifts.map(([id, shift]) => {
                    const started = Math.floor(
                        (Date.now() - new Date(shift.startedAt).getTime()) / 60000
                    );

                    return `<@${id}> — ${started} minutes`;
                }).join("\n");

                const embed = makeEmbed(
                    "Active Staff Shifts",
                    description
                );

                return interaction.reply({
                    embeds: [embed],
                    flags: MessageFlags.Ephemeral
                });
            }
        }

        // ==================================================
        // /STAFF-ANNOUNCEMENT
        // ==================================================

        if (interaction.commandName === "staff-announcement") {
            if (!isStaff(interaction.member, data)) {
                return replyPrivate(
                    interaction,
                    "You do not have permission to send staff announcements."
                );
            }

            const channel = getOptionChannel(interaction, "channel");
            const title = interaction.options.getString("title");
            const message = interaction.options.getString("message");

            const embed = makeEmbed(title, message);

            await interaction.deferReply({
                flags: MessageFlags.Ephemeral
            });

            try {
                await sendWebhookEmbed(channel, embed, {
                    username: "Staff Announcements"
                });

                return interaction.editReply({
                    content: `Your staff announcement has been sent to ${channel}.`
                });
            } catch (error) {
                console.error("Staff announcement error:", error);

                return interaction.editReply({
                    content: `The announcement could not be sent: ${error.message}`
                });
            }
        }

        // ==================================================
        // /STAFF-MANAGE
        // ==================================================

        if (interaction.commandName === "staff-manage") {
            const member = interaction.options.getMember("member");
            const role = interaction.options.getRole("role");
            const action = interaction.options.getString("action");

            if (!member) {
                return replyPrivate(
                    interaction,
                    "That member could not be found in this server."
                );
            }

            if (!role.editable) {
                return replyPrivate(
                    interaction,
                    "I cannot manage that role. Check my role hierarchy."
                );
            }

            if (action === "add") {
                await member.roles.add(role);

                return replyPrivate(
                    interaction,
                    `The ${role.name} role has been added to ${member.user.tag}.`
                );
            }

            if (action === "remove") {
                await member.roles.remove(role);

                return replyPrivate(
                    interaction,
                    `The ${role.name} role has been removed from ${member.user.tag}.`
                );
            }
        }

        // ==================================================
        // /EVENT-CREATE
        // ==================================================

        if (interaction.commandName === "event-create") {
            const channel = getOptionChannel(interaction, "channel");
            const name = interaction.options.getString("name");
            const details = interaction.options.getString("details");
            const date = interaction.options.getString("date");

            const embed = makeEmbed(
                name,
                `${details}\n\n**Date and time**\n${date}`
            );

            embed.setFooter({
                text: interaction.guild.name
            });

            await interaction.deferReply({
                flags: MessageFlags.Ephemeral
            });

            try {
                await sendWebhookEmbed(channel, embed, {
                    username: "Pub Events"
                });

                data.events.push({
                    name,
                    details,
                    date,
                    channelId: channel.id,
                    createdBy: interaction.user.id,
                    createdAt: new Date().toISOString()
                });

                saveDatabase();

                return interaction.editReply({
                    content: `Your event has been announced in ${channel}.`
                });
            } catch (error) {
                console.error("Event creation error:", error);

                return interaction.editReply({
                    content: `The event could not be created: ${error.message}`
                });
            }
        }

    } catch (error) {
        console.error("Interaction error:", error);

        const message = "Something went wrong while processing that command. Please check the bot's permissions and try again.";

        if (interaction.deferred || interaction.replied) {
            await interaction.followUp({
                content: message,
                flags: MessageFlags.Ephemeral
            }).catch(() => null);
        } else {
            await replyPrivate(interaction, message).catch(() => null);
        }
    }
});

// ======================================================
// READY
// ======================================================

client.once("ready", () => {
    console.log(`Pub bot is online as ${client.user.tag}.`);
    console.log(`Connected to ${client.guilds.cache.size} server(s).`);
});

// ======================================================
// STARTUP
// ======================================================

async function startBot() {
    try {
        await registerCommands();
        await client.login(TOKEN);
    } catch (error) {
        console.error("Bot startup failed:", error);
        process.exit(1);
    }
}

startBot();
