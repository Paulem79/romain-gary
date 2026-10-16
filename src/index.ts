import {Client, EmbedBuilder, GatewayIntentBits} from 'discord.js';
import 'dotenv/config';
import {AuthConfig, AuthFeature, GenericModrinthClient, Labrinth} from "@modrinth/api-client";
import Project = Labrinth.Projects.v3.Project;
import {setInterval} from "node:timers";

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

const modrinth = new GenericModrinthClient({
    userAgent: 'romain-gary/1.0.0',
    features: [new AuthFeature({ token: process.env.MODRINTH_TOKEN } as AuthConfig)],
});

const projects_versions = new Map<string, string[]>();

function diff(new_array: string[], old_array: string[]): string[] {
    return new_array.filter(item => !old_array.includes(item));
}

// Successive releases of the same project published within this window, with a similar name,
// are considered part of the same "batch" (e.g. one build per loader / Minecraft version)
const SIMILAR_RELEASE_WINDOW_MS = 15 * 60 * 1000;

type AnnouncedRelease = {
    name: string;
    changelog: string;
    title: string;
    url: string;
    date: number;
};

// Last release announced for each project
const last_announced = new Map<string, AnnouncedRelease>();

const LOADER_KEYWORDS = /\b(fabric|forge|neoforge|quilt|paper|spigot|bukkit|purpur|folia|velocity|bungeecord|waterfall|sponge|mc)\b/g;

function normalizeName(name: string): string {
    return name.toLowerCase().replace(LOADER_KEYWORDS, "").replace(/[^a-z0-9.]+/g, " ").trim();
}

function levenshtein(a: string, b: string): number {
    const row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        let prev = row[0]!;
        row[0] = i;
        for (let j = 1; j <= b.length; j++) {
            const tmp = row[j]!;
            row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
            prev = tmp;
        }
    }
    return row[b.length]!;
}

function isSimilarName(a: string, b: string): boolean {
    const na = normalizeName(a);
    const nb = normalizeName(b);
    if (na === nb) return true;

    // Same base version number (e.g. "1.2.0+fabric" / "1.2.0-neoforge-1.21")
    const va = na.match(/\d+(\.\d+)+/)?.[0];
    const vb = nb.match(/\d+(\.\d+)+/)?.[0];
    if (va && vb && va === vb) return true;

    const maxLength = Math.max(na.length, nb.length);
    return maxLength > 0 && 1 - levenshtein(na, nb) / maxLength >= 0.8;
}

const MOD_ROLE = "<@&1369009317315088414>";
const PLUGIN_ROLE = "<@&1369009253389570068>";

async function trigger_diff(project: Project, difference: string[], mentioned: Set<string>) {
    const isPlugin = project.project_types.includes("plugin");

    const channelId = isPlugin ? "1369056846782005248" : "1369056776019906579";
    const role = isPlugin ? PLUGIN_ROLE : MOD_ROLE;
    const channel = await client.channels.fetch(channelId);
    if(!channel || !channel.isTextBased() || !("send" in channel)) return;

    const versions = await modrinth.labrinth.versions_v3.getVersions(difference);
    versions.sort((a, b) => new Date(a.date_published).getTime() - new Date(b.date_published).getTime());

    for (let version of versions) {
        const title = `${project.name} ${version.version_number} (${version.version_type})`;
        const url = `https://modrinth.com/mod/${project.slug}/version/${version.id}`;
        const date = new Date(version.date_published).getTime();
        const changelog = version.changelog?.trim() || "";

        const previous = last_announced.get(project.id);
        const isRecent = previous !== undefined && Math.abs(date - previous.date) <= SIMILAR_RELEASE_WINDOW_MS;
        const isFollowUp = isRecent && isSimilarName(version.version_number, previous.name);
        const sameChangelog = isRecent && changelog !== "" && changelog === previous.changelog;

        let description: string;
        if (sameChangelog) {
            description = `Same changelog as [${previous.title}](${previous.url}) | Même changelog que [${previous.title}](${previous.url})`;
        } else {
            description = changelog.substring(0, 3000) || 'No changelog available';
        }

        const embed = new EmbedBuilder()
            .setColor(project.color || 0x0099ff)
            .setThumbnail(project.icon_url || null)
            .setTitle(title)
            .setURL(url)
            .setDescription(description)
            .setTimestamp(new Date(version.date_published))
            .setFooter({ text: 'Generated automatically at each release | Généré automatiquement à chaque release' });

        const content = isFollowUp || mentioned.has(role) ? "" : role;
        mentioned.add(role);
        await channel.send({ content, embeds: [embed] });

        // Keep the original changelog reference so a chain of identical changelogs points to the first one
        last_announced.set(project.id, {
            name: version.version_number,
            changelog,
            title: sameChangelog ? previous.title : title,
            url: sameChangelog ? previous.url : url,
            date,
        });
    }
}

async function checkVersions() {
    console.log("Checking for new versions...");

    const mentioned = new Set<string>();

    let projects: Project[];
    try {
        projects = await modrinth.labrinth.users_v3.getProjects('Paulem79');
    } catch (error) {
        console.error("Error fetching projects (will retry next tick):", error);
        return;
    }

    for (const project of projects) {
        if(project.status != "approved") continue;

        try {
            const versions = await modrinth.labrinth.versions_v3.getVersions(project.versions);
            const versionsIds = projects_versions.get(project.id) || [];
            const newVersionsIds = versions.map(v => v.id);

            if(versionsIds.length > 0) {
                const difference = diff(newVersionsIds, versionsIds);
                if(difference.length > 0) {
                    await trigger_diff(project, difference, mentioned);
                }
            }

            projects_versions.set(project.id, newVersionsIds);
        } catch (error) {
            console.error(`Error for ${project.slug}:`, error);
        }
    }

    console.log("Done checking.");
}

client.once('clientReady', async(readyClient) => {
    console.log(`Connected as ${readyClient.user.tag} !`);
    readyClient.user.setStatus("dnd");
    readyClient.user.setActivity("Regarde les publications Modrinth", { type: 3 })

    try {
        await checkVersions();
        setInterval(checkVersions, 30000);
    } catch (error) {
        console.error("Error checking versions:", error);
    }
});

client.on("messageCreate", async(message) => {
    // The good old days
    if (message.content === '+ping') {
        await message.reply(`🏓 Latency is ${Date.now() - message.createdTimestamp}ms. API Latency is ${Math.round(client.ws.ping)}ms`);
    }
});

client.login(process.env.DISCORD_TOKEN);
