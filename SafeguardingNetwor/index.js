require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");

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
    AttachmentBuilder,
    MessageFlags
} = require("discord.js");

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

const DEFAULT_COLOUR = 0x2F6146;
const TICKET_PING_ROLE = "1566481343645483181";

if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
    console.error("Missing DISCORD_TOKEN, CLIENT_ID or GUILD_ID.");
    process.exit(1);
}

// --------------------------------------------------
// DATABASE
// --------------------------------------------------

const DATA_DIRECTORY = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIRECTORY, "guild-data.json");

if (!fs.existsSync(DATA_DIRECTORY)) {
    fs.mkdirSync(DATA_DIRECTORY, { recursive: true });
}

function loadDatabase() {
    try {
        return fs.existsSync(DATA_FILE)
            ? JSON.parse(fs.readFileSync(DATA_FILE, "utf8"))
            : {};
    } catch (error) {
        console.error("Database loading error:", error);
        return {};
    }
}

const database = loadDatabase();

function saveDatabase() {
    fs.writeFileSync(
        DATA_FILE,
        JSON.stringify(database, null, 2)
    );
}

function getGuildData(guildId) {
    if (!database[guildId]) {
        database[guildId] = {
            settings: {
                reviewChannel: null,
                ticketPanelChannel: null,
                ticketLogChannel: null,
                staffRole: null,
                ticketCategories: {
                    general: null,
                    staff: null,
                    other: null
                }
            },
            reviews: [],
            tickets: {},
            shifts: {},
            events: []
        };

        saveDatabase();
    }

    return database[guildId];
}

// --------------------------------------------------
// CLIENT
// --------------------------------------------------

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers
    ]
});

// --------------------------------------------------
// PERMISSIONS AND HELPERS
// --------------------------------------------------

function isStaff(member, settings) {
    if (!member) return false;

    return (
        member.permissions.has(PermissionFlagsBits.Administrator) ||
        member.permissions.has(PermissionFlagsBits.ManageGuild) ||
        (
            settings.staffRole &&
            member.roles.cache.has(settings.staffRole)
        )
    );
}

function parseColour(value) {
    if (!value) return DEFAULT_COLOUR;

    const cleaned = value.replace("#", "");

    if (!/^[0-9a-fA-F]{6}$/.test(cleaned)) {
        return DEFAULT_COLOUR;
    }

    return parseInt(cleaned, 16);
}

function validUrl(value) {
    if (!value) return null;

    try {
        const url = new URL(value);

        if (!["http:", "https:"].includes(url.protocol)) {
            return null;
        }

        return url.toString();
    } catch {
        return null;
    }
}

function truncate(value, length) {
    return String(value ?? "").slice(0, length);
}

// --------------------------------------------------
// WEBHOOK SYSTEM
// --------------------------------------------------

async function getBotWebhook(channel) {
    if (!channel || !channel.isTextBased() || !channel.guild) {
        throw new Error("Invalid webhook destination.");
    }

    const hooks = await channel.fetchWebhooks();

    let webhook = hooks.find(
        hook =>
            hook.owner?.id === client.user.id &&
            hook.name === "Pub Bot Webhooks"
    );

    if (!webhook) {
        webhook = await channel.createWebhook({
            name: "Pub Bot Webhooks",
            reason: "Webhook delivery for the pub Discord bot"
        });
    }

    return webhook;
}

async function sendWebhook(channel, options) {
    const webhook = await getBotWebhook(channel);

    return webhook.send({
        username: options.username || "Pub Bot",
        content: options.content || undefined,
        embeds: options.embeds || [],
        components: options.components || [],
        files: options.files || [],
        allowedMentions: options.allowedMentions || {
            parse: [],
            users: [],
            roles: []
        }
    });
}

async function sendWebhookEmbed(channel, embed, options = {}) {
    return sendWebhook(channel, {
        username: options.username,
        content: options.content,
        embeds: [embed],
        components: options.components,
        files: options.files,
        allowedMentions: options.allowedMentions
    });
}

// --------------------------------------------------
// SLASH COMMANDS
// --------------------------------------------------

const commands = [

    new SlashCommandBuilder()
        .setName("setup")
        .setDescription("Configure the pub bot.")
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)

        .addChannelOption(option =>
            option.setName("review_channel")
                .setDescription("Customer review destination.")
                .addChannelTypes(ChannelType.GuildText)
        )

        .addChannelOption(option =>
            option.setName("ticket_panel_channel")
                .setDescription("Where the ticket panel is posted.")
                .addChannelTypes(ChannelType.GuildText)
        )

        .addChannelOption(option =>
            option.setName("ticket_log_channel")
                .setDescription("Where ticket transcripts are sent.")
                .addChannelTypes(ChannelType.GuildText)
        )

        .addRoleOption(option =>
            option.setName("staff_role")
                .setDescription("Authorised staff role.")
        )

        .addChannelOption(option =>
            option.setName("general_category")
                .setDescription("General Enquiries ticket category.")
                .addChannelTypes(ChannelType.GuildCategory)
        )

        .addChannelOption(option =>
            option.setName("staff_category")
                .setDescription("Staff Support ticket category.")
                .addChannelTypes(ChannelType.GuildCategory)
        )

        .addChannelOption(option =>
            option.setName("other_category")
                .setDescription("Other Enquiries ticket category.")
                .addChannelTypes(ChannelType.GuildCategory)
        )

        .addBooleanOption(option =>
            option.setName("post_ticket_panel")
                .setDescription("Post the ticket panel after saving.")
        ),

    new SlashCommandBuilder()
        .setName("embed")
        .setDescription("Create and publish a customised webhook embed.")
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)

        .addChannelOption(option =>
            option.setName("channel")
                .setDescription("Destination channel.")
                .setRequired(true)
                .addChannelTypes(
                    ChannelType.GuildText,
                    ChannelType.GuildAnnouncement
                )
        )

        .addStringOption(option =>
            option.setName("title")
                .setDescription("Embed title.")
                .setRequired(true)
                .setMaxLength(256)
        )

        .addStringOption(option =>
            option.setName("description")
                .setDescription("Embed description.")
                .setRequired(true)
                .setMaxLength(4000)
        )

        .addStringOption(option =>
            option.setName("colour")
                .setDescription("Hex colour, such as 2F6146.")
        )

        .addStringOption(option =>
            option.setName("image")
                .setDescription("Optional image URL.")
        )

        .addStringOption(option =>
            option.setName("thumbnail")
                .setDescription("Optional thumbnail URL.")
        )

        .addStringOption(option =>
            option.setName("footer")
                .setDescription("Optional footer.")
                .setMaxLength(2048)
        )

        .addStringOption(option =>
            option.setName("author")
                .setDescription("Optional author name.")
                .setMaxLength(256)
        )

        .addStringOption(option =>
            option.setName("webhook_name")
                .setDescription("Custom webhook display name.")
                .setMaxLength(80)
        ),

    new SlashCommandBuilder()
        .setName("announce")
        .setDescription("Publish an announcement.")
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)

        .addChannelOption(option =>
            option.setName("channel")
                .setDescription("Announcement channel.")
                .setRequired(true)
                .addChannelTypes(
                    ChannelType.GuildText,
                    ChannelType.GuildAnnouncement
                )
        )

        .addStringOption(option =>
            option.setName("title")
                .setDescription("Announcement title.")
                .setRequired(true)
                .setMaxLength(256)
        )

        .addStringOption(option =>
            option.setName("message")
                .setDescription("Announcement description.")
                .setRequired(true)
                .setMaxLength(4000)
        )

        .addStringOption(option =>
            option.setName("image")
                .setDescription("Optional image URL.")
        ),

    new SlashCommandBuilder()
        .setName("review")
        .setDescription("Submit a customer review.")

        .addIntegerOption(option =>
            option.setName("rating")
                .setDescription("Rating from 1 to 5.")
                .setRequired(true)
                .setMinValue(1)
                .setMaxValue(5)
        )

        .addStringOption(option =>
            option.setName("review")
                .setDescription("Your written review.")
                .setRequired(true)
                .setMinLength(5)
                .setMaxLength(1500)
        ),

    new SlashCommandBuilder()
        .setName("review-manage")
        .setDescription("Manage customer reviews.")
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)

        .addStringOption(option =>
            option.setName("action")
                .setDescription("Review management action.")
                .setRequired(true)
                .addChoices(
                    { name: "View pending", value: "view" },
                    { name: "Approve", value: "approve" },
                    { name: "Remove", value: "remove" }
                )
        )

        .addStringOption(option =>
            option.setName("review_id")
                .setDescription("Review ID.")
        ),

    new SlashCommandBuilder()
        .setName("shift-management")
        .setDescription("Manage staff shifts.")

        .addStringOption(option =>
            option.setName("action")
                .setDescription("Shift action.")
                .setRequired(true)
                .addChoices(
                    { name: "Start shift", value: "start" },
                    { name: "End shift", value: "end" },
                    { name: "View active shifts", value: "active" }
                )
        ),

    new SlashCommandBuilder()
        .setName("staff-announcement")
        .setDescription("Publish a staff announcement.")
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)

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
                .setMaxLength(256)
        )

        .addStringOption(option =>
            option.setName("message")
                .setDescription("Announcement message.")
                .setRequired(true)
                .setMaxLength(4000)
        ),

    new SlashCommandBuilder()
        .setName("staff-manage")
        .setDescription("Manage staff role membership.")
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)

        .addStringOption(option =>
            option.setName("action")
                .setDescription("Staff role action.")
                .setRequired(true)
                .addChoices(
                    { name: "Add staff role", value: "add" },
                    { name: "Remove staff role", value: "remove" }
                )
        )

        .addUserOption(option =>
            option.setName("member")
                .setDescription("Member to update.")
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName("event-create")
        .setDescription("Create a pub event.")
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)

        .addChannelOption(option =>
            option.setName("channel")
                .setDescription("Event announcement channel.")
                .setRequired(true)
                .addChannelTypes(
                    ChannelType.GuildText,
                    ChannelType.GuildAnnouncement
                )
        )

        .addStringOption(option =>
            option.setName("name")
                .setDescription("Event name.")
                .setRequired(true)
                .setMaxLength(256)
        )

        .addStringOption(option =>
            option.setName("details")
                .setDescription("Event details.")
                .setRequired(true)
                .setMaxLength(3500)
        )

        .addStringOption(option =>
            option.setName("date")
                .setDescription("Event date and time.")
                .setRequired(true)
                .setMaxLength(100)
        )

].map(command => command.toJSON());

// --------------------------------------------------
// TICKET PANEL
// --------------------------------------------------

function buildTicketPanel() {
    const embed = new EmbedBuilder()
        .setColor(DEFAULT_COLOUR)
        .setTitle("Customer Support")
        .setDescription(
            "Welcome to our support centre.\n\n" +
            "Select the category that best matches your enquiry. " +
            "A private ticket will be created and directed to the appropriate team.\n\n" +

            "**General Enquiries**\n" +
            "For general questions, information and assistance.\n\n" +

            "**Staff Support**\n" +
            "For existing staff members who need help with staff-related matters.\n\n" +

            "**Other Enquiries**\n" +
            "For anything that does not fit the categories above.\n\n" +

            "Please open one ticket at a time and provide enough information " +
            "to help our team deal with your enquiry."
        )
        .setFooter({
            text: "Please allow our team time to respond."
        });

    const menu = new StringSelectMenuBuilder()
        .setCustomId("ticket_category")
        .setPlaceholder("Choose a ticket category")
        .addOptions(
            {
                label: "General Enquiries",
                description: "General questions and assistance.",
                value: "general"
            },
            {
                label: "Staff Support",
                description: "Support for existing staff members.",
                value: "staff"
            },
            {
                label: "Other Enquiries",
                description: "Anything not covered by the other categories.",
                value: "other"
            }
        );

    return {
        embed,
        components: [
            new ActionRowBuilder().addComponents(menu)
        ]
    };
}

async function postTicketPanel(channel) {
    const panel = buildTicketPanel();

    return sendWebhookEmbed(channel, panel.embed, {
        components: panel.components
    });
}

// --------------------------------------------------
// TICKET WELCOME EMBEDS
// --------------------------------------------------

function buildTicketWelcome(category, user) {
    const information = {
        general: {
            title: "General Enquiries",
            description:
                "Thank you for contacting us.\n\n" +
                "Please explain your question or enquiry in as much detail as possible. " +
                "A member of our team will respond when available."
        },

        staff: {
            title: "Staff Support",
            description:
                "This ticket is for existing staff members who need assistance.\n\n" +
                "Please explain the staff-related matter and include any relevant details " +
                "so the appropriate team member can help."
        },

        other: {
            title: "Other Enquiries",
            description:
                "Thank you for contacting us.\n\n" +
                "Please describe what you need help with and provide any relevant information. " +
                "Our team will review your enquiry and respond when available."
        }
    };

    const selected = information[category];

    return new EmbedBuilder()
        .setColor(DEFAULT_COLOUR)
        .setTitle(selected.title)
        .setDescription(selected.description)
        .addFields({
            name: "Ticket opened by",
            value: `<@${user.id}>`
        })
        .setFooter({
            text: "Please keep all information relevant to this enquiry."
        })
        .setTimestamp();
}

// --------------------------------------------------
// CREATE TICKET
// --------------------------------------------------

async function createTicket(interaction, category) {
    const data = getGuildData(interaction.guildId);
    const settings = data.settings;

    const destinationId = settings.ticketCategories[category];

    if (!destinationId) {
        return interaction.reply({
            content: "This ticket category has not been configured by an administrator.",
            flags: MessageFlags.Ephemeral
        });
    }

    const existingTicket = Object.values(data.tickets).find(
        ticket =>
            ticket.userId === interaction.user.id &&
            ticket.status === "open"
    );

    if (existingTicket) {
        return interaction.reply({
            content: `You already have an open ticket: <#${existingTicket.channelId}>.`,
            flags: MessageFlags.Ephemeral
        });
    }

    const parent = await interaction.guild.channels
        .fetch(destinationId)
        .catch(() => null);

    if (!parent || parent.type !== ChannelType.GuildCategory) {
        return interaction.reply({
            content: "The configured ticket category could not be found.",
            flags: MessageFlags.Ephemeral
        });
    }

    const username = interaction.user.username
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "-")
        .replace(/-+/g, "-")
        .slice(0, 18) || "member";

    const channel = await interaction.guild.channels.create({
        name: `ticket-${username}`,
        type: ChannelType.GuildText,
        parent: parent.id,

        topic:
            `Ticket opened by ${interaction.user.tag} ` +
            `(${interaction.user.id}). Type: ${category}`,

        permissionOverwrites: [
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
                    PermissionFlagsBits.AttachFiles
                ]
            },
            {
                id: client.user.id,
                allow: [
                    PermissionFlagsBits.ViewChannel,
                    PermissionFlagsBits.SendMessages,
                    PermissionFlagsBits.ReadMessageHistory,
                    PermissionFlagsBits.ManageChannels,
                    PermissionFlagsBits.ManageWebhooks,
                    PermissionFlagsBits.AttachFiles
                ]
            },
            ...(settings.staffRole ? [{
                id: settings.staffRole,
                allow: [
                    PermissionFlagsBits.ViewChannel,
                    PermissionFlagsBits.SendMessages,
                    PermissionFlagsBits.ReadMessageHistory,
                    PermissionFlagsBits.ManageMessages
                ]
            }] : [])
        ],

        reason: `Ticket opened by ${interaction.user.tag}`
    });

    data.tickets[channel.id] = {
        channelId: channel.id,
        userId: interaction.user.id,
        category,
        status: "open",
        createdAt: new Date().toISOString()
    };

    saveDatabase();

    const closeButton = new ButtonBuilder()
        .setCustomId("ticket_close")
        .setLabel("Close ticket")
        .setStyle(ButtonStyle.Danger);

    const row = new ActionRowBuilder().addComponents(closeButton);

    await sendWebhookEmbed(
        channel,
        buildTicketWelcome(category, interaction.user),
        {
            content:
                `<@${interaction.user.id}> <@&${TICKET_PING_ROLE}>`,

            components: [row],

            allowedMentions: {
                users: [interaction.user.id],
                roles: [TICKET_PING_ROLE]
            }
        }
    );

    return interaction.reply({
        content: `Your ticket has been created: ${channel}.`,
        flags: MessageFlags.Ephemeral
    });
}

// --------------------------------------------------
// CLOSE TICKET AND TRANSCRIPT
// --------------------------------------------------

async function closeTicket(interaction) {
    const data = getGuildData(interaction.guildId);
    const ticket = data.tickets[interaction.channelId];

    if (!ticket || ticket.status !== "open") {
        return interaction.reply({
            content: "This is not an open support ticket.",
            flags: MessageFlags.Ephemeral
        });
    }

    if (
        interaction.user.id !== ticket.userId &&
        !isStaff(interaction.member, data.settings)
    ) {
        return interaction.reply({
            content: "Only the ticket opener or authorised staff can close this ticket.",
            flags: MessageFlags.Ephemeral
        });
    }

    await interaction.deferReply({
        flags: MessageFlags.Ephemeral
    });

    const messages = await interaction.channel.messages.fetch({
        limit: 100
    });

    const transcript = [...messages.values()]
        .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
        .map(message => {
            const timestamp = new Date(
                message.createdTimestamp
            ).toISOString();

            const content = message.content ||
                (message.attachments.size
                    ? [...message.attachments.values()]
                        .map(attachment => attachment.url)
                        .join(", ")
                    : "[No text content]");

            return `[${timestamp}] ${message.author.tag}: ${content}`;
        })
        .join("\n");

    const logChannelId = data.settings.ticketLogChannel;
    const logChannel = logChannelId
        ? await interaction.guild.channels.fetch(logChannelId).catch(() => null)
        : null;

    if (logChannel && logChannel.isTextBased()) {
        const transcriptFile = new AttachmentBuilder(
            Buffer.from(transcript || "No messages recorded.", "utf8"),
            {
                name: `transcript-${interaction.channelId}.txt`
            }
        );

        const logEmbed = new EmbedBuilder()
            .setColor(DEFAULT_COLOUR)
            .setTitle("Ticket Transcript")
            .setDescription(
                `**Ticket:** ${interaction.channel.name}\n` +
                `**Opened by:** <@${ticket.userId}>\n` +
                `**Category:** ${ticket.category}\n` +
                `**Closed by:** <@${interaction.user.id}>`
            )
            .setTimestamp();

        await sendWebhookEmbed(logChannel, logEmbed, {
            files: [transcriptFile]
        }).catch(console.error);
    }

    ticket.status = "closed";
    ticket.closedAt = new Date().toISOString();
    ticket.closedBy = interaction.user.id;

    saveDatabase();

    await interaction.editReply({
        content: "The ticket has been closed. The channel will now be deleted."
    });

    await interaction.channel.delete(
        `Ticket closed by ${interaction.user.tag}`
    );
}

// --------------------------------------------------
// READY AND COMMAND REGISTRATION
// --------------------------------------------------

client.once("ready", async () => {
    console.log(`Bot online as ${client.user.tag}`);

    try {
        const rest = new REST({ version: "10" }).setToken(TOKEN);

        await rest.put(
            Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
            { body: commands }
        );

        console.log(`${commands.length} slash commands registered.`);
    } catch (error) {
        console.error("Command registration error:", error);
    }
});

// --------------------------------------------------
// INTERACTIONS
// --------------------------------------------------

client.on("interactionCreate", async interaction => {
    try {

        // Ticket category selection

        if (
            interaction.isStringSelectMenu() &&
            interaction.customId === "ticket_category"
        ) {
            return createTicket(
                interaction,
                interaction.values[0]
            );
        }

        // Ticket close button

        if (
            interaction.isButton() &&
            interaction.customId === "ticket_close"
        ) {
            return closeTicket(interaction);
        }

        if (!interaction.isChatInputCommand()) return;

        const data = getGuildData(interaction.guildId);
        const settings = data.settings;

        // --------------------------------------------------
        // SETUP
        // --------------------------------------------------

        if (interaction.commandName === "setup") {
            const reviewChannel =
                interaction.options.getChannel("review_channel");

            const panelChannel =
                interaction.options.getChannel("ticket_panel_channel");

            const logChannel =
                interaction.options.getChannel("ticket_log_channel");

            const staffRole =
                interaction.options.getRole("staff_role");

            const general =
                interaction.options.getChannel("general_category");

            const staff =
                interaction.options.getChannel("staff_category");

            const other =
                interaction.options.getChannel("other_category");

            if (reviewChannel) settings.reviewChannel = reviewChannel.id;
            if (panelChannel) settings.ticketPanelChannel = panelChannel.id;
            if (logChannel) settings.ticketLogChannel = logChannel.id;
            if (staffRole) settings.staffRole = staffRole.id;

            if (general) settings.ticketCategories.general = general.id;
            if (staff) settings.ticketCategories.staff = staff.id;
            if (other) settings.ticketCategories.other = other.id;

            saveDatabase();

            let panelMessage = "";

            if (interaction.options.getBoolean("post_ticket_panel")) {
                const destination = settings.ticketPanelChannel
                    ? await interaction.guild.channels
                        .fetch(settings.ticketPanelChannel)
                        .catch(() => null)
                    : null;

                if (!destination) {
                    panelMessage =
                        "\nThe panel could not be posted. Configure a ticket panel channel first.";
                } else {
                    await postTicketPanel(destination);
                    panelMessage = `\nTicket panel posted in ${destination}.`;
                }
            }

            return interaction.reply({
                content:
                    "Bot configuration saved.\n\n" +
                    `Review channel: ${settings.reviewChannel ? `<#${settings.reviewChannel}>` : "Not configured"}\n` +
                    `Ticket panel channel: ${settings.ticketPanelChannel ? `<#${settings.ticketPanelChannel}>` : "Not configured"}\n` +
                    `Transcript channel: ${settings.ticketLogChannel ? `<#${settings.ticketLogChannel}>` : "Not configured"}\n` +
                    `Staff role: ${settings.staffRole ? `<@&${settings.staffRole}>` : "Not configured"}\n` +
                    `General Enquiries category: ${settings.ticketCategories.general ? `<#${settings.ticketCategories.general}>` : "Not configured"}\n` +
                    `Staff Support category: ${settings.ticketCategories.staff ? `<#${settings.ticketCategories.staff}>` : "Not configured"}\n` +
                    `Other Enquiries category: ${settings.ticketCategories.other ? `<#${settings.ticketCategories.other}>` : "Not configured"}` +
                    panelMessage,
                flags: MessageFlags.Ephemeral
            });
        }

        // --------------------------------------------------
        // CUSTOM WEBHOOK EMBED
        // --------------------------------------------------

        if (interaction.commandName === "embed") {
            const channel = interaction.options.getChannel("channel");

            const title = interaction.options.getString("title");
            const description = interaction.options.getString("description");

            const colour = parseColour(
                interaction.options.getString("colour")
            );

            const image = interaction.options.getString("image");
            const thumbnail = interaction.options.getString("thumbnail");
            const footer = interaction.options.getString("footer");
            const author = interaction.options.getString("author");

            const webhookName =
                interaction.options.getString("webhook_name");

            if (image && !validUrl(image)) {
                return interaction.reply({
                    content: "The image URL is invalid.",
                    flags: MessageFlags.Ephemeral
                });
            }

            if (thumbnail && !validUrl(thumbnail)) {
                return interaction.reply({
                    content: "The thumbnail URL is invalid.",
                    flags: MessageFlags.Ephemeral
                });
            }

            const embed = new EmbedBuilder()
                .setColor(colour)
                .setTitle(title)
                .setDescription(description);

            if (image) embed.setImage(validUrl(image));
            if (thumbnail) embed.setThumbnail(validUrl(thumbnail));
            if (footer) embed.setFooter({ text: footer });
            if (author) embed.setAuthor({ name: author });

            await sendWebhookEmbed(channel, embed, {
                username: webhookName || "Pub Bot"
            });

            return interaction.reply({
                content: `Your customised embed has been published in ${channel}.`,
                flags: MessageFlags.Ephemeral
            });
        }

        // --------------------------------------------------
        // ANNOUNCEMENTS
        // --------------------------------------------------

        if (
            interaction.commandName === "announce" ||
            interaction.commandName === "staff-announcement"
        ) {
            const channel = interaction.options.getChannel("channel");
            const title = interaction.options.getString("title");
            const message = interaction.options.getString("message");

            const embed = new EmbedBuilder()
                .setColor(DEFAULT_COLOUR)
                .setTitle(title)
                .setDescription(message);

            if (interaction.commandName === "announce") {
                const image = interaction.options.getString("image");

                if (image && !validUrl(image)) {
                    return interaction.reply({
                        content: "The image URL is invalid.",
                        flags: MessageFlags.Ephemeral
                    });
                }

                if (image) embed.setImage(validUrl(image));
            }

            await sendWebhookEmbed(channel, embed);

            return interaction.reply({
                content: `The announcement has been published in ${channel}.`,
                flags: MessageFlags.Ephemeral
            });
        }

        // --------------------------------------------------
        // CUSTOMER REVIEWS
        // --------------------------------------------------

        if (interaction.commandName === "review") {
            if (!settings.reviewChannel) {
                return interaction.reply({
                    content: "The review channel has not been configured.",
                    flags: MessageFlags.Ephemeral
                });
            }

            const review = {
                id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
                userId: interaction.user.id,
                rating: interaction.options.getInteger("rating"),
                text: interaction.options.getString("review"),
                status: "pending",
                createdAt: new Date().toISOString()
            };

            data.reviews.push(review);
            saveDatabase();

            return interaction.reply({
                content:
                    "Thank you. Your review has been submitted privately for staff approval.",
                flags: MessageFlags.Ephemeral
            });
        }

        // --------------------------------------------------
        // REVIEW MANAGEMENT
        // --------------------------------------------------

        if (interaction.commandName === "review-manage") {
            if (!isStaff(interaction.member, settings)) {
                return interaction.reply({
                    content: "You are not authorised to manage reviews.",
                    flags: MessageFlags.Ephemeral
                });
            }

            const action = interaction.options.getString("action");
            const reviewId = interaction.options.getString("review_id");

            if (action === "view") {
                const pending = data.reviews
                    .filter(review => review.status === "pending")
                    .slice(0, 10);

                if (!pending.length) {
                    return interaction.reply({
                        content: "There are no pending reviews.",
                        flags: MessageFlags.Ephemeral
                    });
                }

                const description = pending.map(review =>
                    `**Review ID:** ${review.id}\n` +
                    `**Rating:** ${review.rating}/5\n` +
                    `**Submitted by:** <@${review.userId}>\n` +
                    `**Review:** ${review.text}`
                ).join("\n\n");

                return interaction.reply({
                    content: description.slice(0, 1900),
                    flags: MessageFlags.Ephemeral
                });
            }

            if (!reviewId) {
                return interaction.reply({
                    content: "Please provide a review ID.",
                    flags: MessageFlags.Ephemeral
                });
            }

            const review = data.reviews.find(
                item => item.id === reviewId
            );

            if (!review) {
                return interaction.reply({
                    content: "That review could not be found.",
                    flags: MessageFlags.Ephemeral
                });
            }

            if (action === "remove") {
                review.status = "removed";
                review.reviewedBy = interaction.user.id;
                saveDatabase();

                return interaction.reply({
                    content: "The review has been removed.",
                    flags: MessageFlags.Ephemeral
                });
            }

            if (action === "approve") {
                if (review.status !== "pending") {
                    return interaction.reply({
                        content: "Only pending reviews can be approved.",
                        flags: MessageFlags.Ephemeral
                    });
                }

                const channel = await interaction.guild.channels
                    .fetch(settings.reviewChannel)
                    .catch(() => null);

                if (!channel) {
                    return interaction.reply({
                        content: "The review channel is unavailable.",
                        flags: MessageFlags.Ephemeral
                    });
                }

                const embed = new EmbedBuilder()
                    .setColor(DEFAULT_COLOUR)
                    .setTitle("Customer Review")
                    .setDescription(review.text)
                    .addFields(
                        {
                            name: "Rating",
                            value: `${review.rating}/5`,
                            inline: true
                        },
                        {
                            name: "Submitted by",
                            value: `<@${review.userId}>`,
                            inline: true
                        }
                    )
                    .setTimestamp(new Date(review.createdAt));

                await sendWebhookEmbed(channel, embed);

                review.status = "approved";
                review.reviewedBy = interaction.user.id;
                review.approvedAt = new Date().toISOString();

                saveDatabase();

                return interaction.reply({
                    content: "The review has been approved and published.",
                    flags: MessageFlags.Ephemeral
                });
            }
        }

        // --------------------------------------------------
        // STAFF SHIFTS
        // --------------------------------------------------

        if (interaction.commandName === "shift-management") {
            const action = interaction.options.getString("action");
            const userId = interaction.user.id;

            if (action === "start") {
                if (data.shifts[userId]?.active) {
                    return interaction.reply({
                        content: "You already have an active shift.",
                        flags: MessageFlags.Ephemeral
                    });
                }

                data.shifts[userId] = {
                    active: true,
                    startedAt: new Date().toISOString()
                };

                saveDatabase();

                return interaction.reply({
                    content: "Your staff shift has started.",
                    flags: MessageFlags.Ephemeral
                });
            }

            if (action === "end") {
                const shift = data.shifts[userId];

                if (!shift?.active) {
                    return interaction.reply({
                        content: "You do not have an active shift.",
                        flags: MessageFlags.Ephemeral
                    });
                }

                shift.active = false;
                shift.endedAt = new Date().toISOString();

                saveDatabase();

                return interaction.reply({
                    content: "Your staff shift has ended.",
                    flags: MessageFlags.Ephemeral
                });
            }

            const activeShifts = Object.entries(data.shifts)
                .filter(([, shift]) => shift.active);

            const lines = activeShifts.map(([id, shift]) =>
                `<@${id}> — started <t:${Math.floor(new Date(shift.startedAt).getTime() / 1000)}:R>`
            );

            return interaction.reply({
                content: lines.length
                    ? `Active staff shifts:\n${lines.join("\n")}`
                    : "There are no active staff shifts.",
                flags: MessageFlags.Ephemeral
            });
        }

        // --------------------------------------------------
        // STAFF MANAGEMENT
        // --------------------------------------------------

        if (interaction.commandName === "staff-manage") {
            if (!settings.staffRole) {
                return interaction.reply({
                    content: "Configure the staff role using /setup first.",
                    flags: MessageFlags.Ephemeral
                });
            }

            const action = interaction.options.getString("action");
            const user = interaction.options.getUser("member");

            const member = await interaction.guild.members
                .fetch(user.id);

            const role = await interaction.guild.roles
                .fetch(settings.staffRole);

            if (!role) {
                return interaction.reply({
                    content: "The configured staff role could not be found.",
                    flags: MessageFlags.Ephemeral
                });
            }

            if (action === "add") {
                await member.roles.add(role);
            } else {
                await member.roles.remove(role);
            }

            return interaction.reply({
                content:
                    `${role.name} has been ${action === "add" ? "added to" : "removed from"} ${member.user.tag}.`,
                flags: MessageFlags.Ephemeral
            });
        }

        // --------------------------------------------------
        // EVENTS
        // --------------------------------------------------

        if (interaction.commandName === "event-create") {
            const channel = interaction.options.getChannel("channel");
            const name = interaction.options.getString("name");
            const details = interaction.options.getString("details");
            const date = interaction.options.getString("date");

            const embed = new EmbedBuilder()
                .setColor(DEFAULT_COLOUR)
                .setTitle(name)
                .setDescription(
                    `${details}\n\n**Date and time:** ${date}`
                )
                .setTimestamp();

            await sendWebhookEmbed(channel, embed);

            data.events.push({
                name,
                details,
                date,
                channelId: channel.id,
                createdBy: interaction.user.id,
                createdAt: new Date().toISOString()
            });

            saveDatabase();

            return interaction.reply({
                content: `The event has been announced in ${channel}.`,
                flags: MessageFlags.Ephemeral
            });
        }

    } catch (error) {
        console.error("Interaction error:", error);

        const response = {
            content:
                "Something went wrong. Check the bot's permissions and console logs.",
            flags: MessageFlags.Ephemeral
        };

        if (interaction.deferred || interaction.replied) {
            await interaction.followUp(response).catch(() => {});
        } else {
            await interaction.reply(response).catch(() => {});
        }
    }
});

// --------------------------------------------------
// ERROR HANDLING
// --------------------------------------------------

client.on("error", error => {
    console.error("Discord client error:", error);
});

process.on("unhandledRejection", error => {
    console.error("Unhandled rejection:", error);
});

// --------------------------------------------------
// LOGIN
// --------------------------------------------------

client.login(TOKEN);
