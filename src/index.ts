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

async function trigger_diff(project: Project, difference: string[]) {
    const channelId = project.project_types.includes("mod") ? "1369056776019906579" : "1369056846782005248";
    const channel = await client.channels.fetch(channelId);
    if(!channel || !channel.isTextBased() || !("send" in channel)) return;

    const versions = await modrinth.labrinth.versions_v3.getVersions(difference);

    for (let version of versions) {
        const embed = new EmbedBuilder()
            .setColor(project.color || 0x0099ff)
            .setThumbnail(project.icon_url || null)
            .setTitle(`${project.name} ${version.version_number} (${version.version_type})`)
            .setURL(`https://modrinth.com/mod/${project.slug}/version/${version.id}`)
            .setDescription(version.changelog?.substring(0, 3000) || 'No changelog available')
            .setTimestamp(new Date(version.date_published))
            .setFooter({ text: 'Generated automatically at each release | Généré automatiquement à chaque release' });
        await channel.send({ embeds: [embed] });
    }
}

async function checkVersions() {
    console.log("Checking for new versions...");

    const projects = await modrinth.labrinth.users_v3.getProjects('Paulem79');
    for (const project of projects) {
        if(project.status != "approved") continue;

        try {
            const versions = await modrinth.labrinth.versions_v3.getVersions(project.versions);
            const versionsIds = projects_versions.get(project.id) || [];
            const newVersionsIds = versions.map(v => v.id);

            if(versionsIds.length > 0) {
                const difference = diff(newVersionsIds, versionsIds);
                if(difference.length > 0) {
                    console.log(`Nouvelles versions pour ${project.slug}:`, difference);
                    await trigger_diff(project, difference);
                }
            }

            projects_versions.set(project.id, newVersionsIds);
        } catch (error) {
            console.error(`Erreur pour ${project.slug}:`, error);
        }
    }

    console.log("Done checking.");
}

client.once('clientReady', async(readyClient) => {
    console.log(`Connected as ${readyClient.user.tag} !`);

    try {
        await checkVersions();
        setInterval(checkVersions, 30000);
    } catch (error) {
        console.error("Error checking versions:", error);
    }
});

// Connexion de notre bot à Discord
client.login(process.env.DISCORD_TOKEN);
