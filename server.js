const express = require("express");
const cors = require("cors");
const path = require("path");
require("dotenv").config();

const app = express();
const port = 3000;

app.use(cors());
app.use(express.static(__dirname));

if (!process.env.RIOT_API_KEY) {
  console.error("RIOT_API_KEY is missing. Add it to .env and restart the server.");
}

const regions = {
  na1: {
    platformHost: "na1.api.riotgames.com",
    routingHost: "americas.api.riotgames.com",
  },
  euw1: {
    platformHost: "euw1.api.riotgames.com",
    routingHost: "europe.api.riotgames.com",
  },
  kr: {
    platformHost: "kr.api.riotgames.com",
    routingHost: "asia.api.riotgames.com",
  },
  oc1: {
    platformHost: "oc1.api.riotgames.com",
    routingHost: "sea.api.riotgames.com",
  },
  sg2: {
    platformHost: "sg2.api.riotgames.com",
    routingHost: "sea.api.riotgames.com",
  },
};

async function riotRequest(host, endpoint, label) {
  try {
    const response = await fetch(`https://${host}${endpoint}`, {
      headers: {
        "X-Riot-Token": process.env.RIOT_API_KEY,
      },
    });

    if (!response.ok) {
      if (response.status !== 429 || label !== "timeline lookup") {
        console.error(`Riot request failed: ${response.status} [${label}] ${host}${endpoint}`);
      }
      return {
        error: response.status === 401
          ? "Riot rejected the API key. Generate a new key and restart the server."
          : response.status === 403
            ? "Riot refused this request. Check that the API key is active and that the selected region matches the player."
          : response.status === 429
            ? "Riot rate limit reached. Wait a moment before loading more data."
          : response.status === 404
            ? "Riot could not find this player in the selected region. Check the Riot ID and tag exactly."
          : `Riot API returned HTTP ${response.status}.`,
        status: response.status,
        stage: label,
      };
    }

    return { data: await response.json() };
  } catch (error) {
    return {
      error: "Could not connect to Riot API.",
      status: 502,
      details: error.message,
    };
  }
}

let championNames;
let itemCatalog;
async function getChampionNames() {
  if (championNames) return championNames;
  const response = await fetch("https://ddragon.leagueoflegends.com/cdn/15.18.1/data/en_US/champion.json");
  if (!response.ok) return {};
  const payload = await response.json();
  championNames = Object.fromEntries(Object.values(payload.data).map((champion) => [Number(champion.key), {
    name: champion.name,
    image: champion.image.full,
  }]));
  return championNames;
}

async function getItemCatalog() {
  if (itemCatalog) return itemCatalog;
  const response = await fetch("https://ddragon.leagueoflegends.com/cdn/15.18.1/data/en_US/item.json");
  if (!response.ok) return {};
  const payload = await response.json();
  itemCatalog = Object.fromEntries(Object.entries(payload.data).map(([id, item]) => [id, {
    name: item.name,
    description: item.description,
    stats: item.stats,
    image: item.image.full,
  }]));
  return itemCatalog;
}

app.get("/api/health", async (_req, res) => {
  const result = await riotRequest(
    "americas.api.riotgames.com",
    "/riot/account/v1/accounts/by-riot-id/test/test",
    "health"
  );

  if (result.error && result.status !== 404) {
    return res.status(result.status).json({ ok: false, error: result.error, stage: result.stage });
  }

  res.json({ ok: true, riotApiReachable: true, note: "A 404 for the test account confirms the key can access Riot." });
});

app.get("/api/player/:region/:gameName/:tagLine", async (req, res) => {
  const { region, gameName, tagLine } = req.params;
  const start = Math.max(0, Number.parseInt(req.query.start, 10) || 0);
  const count = Math.min(10, Math.max(1, Number.parseInt(req.query.count, 10) || 10));
  const selectedRegion = regions[region];

  if (!selectedRegion) {
    return res.status(400).json({ error: "Unsupported routing region" });
  }

  const account = await riotRequest(
    selectedRegion.routingHost,
    `/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`,
    "account lookup"
  );

  if (account.error) {
    return res.status(account.status).json({ error: account.error, stage: account.stage });
  }
  const accountData = account.data;

  const summoner = await riotRequest(
    selectedRegion.platformHost,
    `/lol/summoner/v4/summoners/by-puuid/${accountData.puuid}`,
    "summoner lookup"
  );
  if (summoner.error) {
    return res.status(summoner.status).json({ error: summoner.error, stage: summoner.stage });
  }

  const ranked = await riotRequest(
    selectedRegion.platformHost,
    `/lol/league/v4/entries/by-puuid/${encodeURIComponent(accountData.puuid)}`,
    "rank lookup"
  );

  const matches = await riotRequest(
    selectedRegion.routingHost,
    `/lol/match/v5/matches/by-puuid/${accountData.puuid}/ids?start=${start}&count=${count}`,
    "match lookup"
  );
  if (matches.error) {
    return res.status(matches.status).json({ error: matches.error, stage: matches.stage });
  }

  const matchDetails = (await Promise.all(matches.data.map((matchId) =>
    riotRequest(selectedRegion.routingHost, `/lol/match/v5/matches/${encodeURIComponent(matchId)}`, "match detail lookup")
  ))).filter((match) => match.data).map((match) => match.data);

  // Timelines are expensive API calls. Sample three games to stay within
  // development-key rate limits while still powering the activity heat map.
  const timelineResults = await Promise.all(matches.data.slice(0, 3).map(async (matchId) => ({
    matchId,
    result: await riotRequest(selectedRegion.routingHost, `/lol/match/v5/matches/${encodeURIComponent(matchId)}/timeline`, "timeline lookup"),
  })));
  const timelines = timelineResults.map((item) => item.result.data).filter(Boolean);
  timelineResults.forEach(({ matchId, result }) => {
    const match = matchDetails.find((item) => (item.metadata?.matchId || item.info.gameId) === matchId);
    if (match && result.data) match.timeline = result.data;
  });

  const mastery = await riotRequest(
    selectedRegion.platformHost,
    `/lol/champion-mastery/v4/champion-masteries/by-puuid/${encodeURIComponent(accountData.puuid)}/top?count=50`,
    "mastery lookup"
  );
  const names = await getChampionNames();
  const items = await getItemCatalog();
  const playerParticipantIds = new Set(matchDetails.flatMap((match) => {
    const participant = match.info.participants.find((item) => item.puuid === accountData.puuid);
    return participant ? [participant.participantId] : [];
  }));
  const activity = [0, 0, 0, 0];
  timelines.forEach((timeline) => timeline.info.frames.forEach((frame) => frame.events.forEach((event) => {
    const minute = Math.min(3, Math.floor(event.timestamp / 600000));
    const involved = event.participantId && playerParticipantIds.has(event.participantId)
      || event.killerId && playerParticipantIds.has(event.killerId)
      || (event.assistingParticipantIds || []).some((id) => playerParticipantIds.has(id));
    if (involved && ["CHAMPION_KILL", "WARD_PLACED", "WARD_KILL", "ELITE_MONSTER_KILL"].includes(event.type)) activity[minute] += 1;
  })));
  const playerStats = matchDetails.flatMap((match) => {
    const participant = match.info.participants.find((item) => item.puuid === accountData.puuid);
    if (!participant) return [];
    const team = match.info.participants.filter((item) => item.teamId === participant.teamId);
    const teamKills = team.reduce((total, item) => total + item.kills, 0);
    return [{
      kills: participant.kills,
      assists: participant.assists,
      deaths: participant.deaths,
      killParticipation: teamKills ? (participant.kills + participant.assists) / teamKills : 0,
      wardsPlaced: participant.wardsPlaced || 0,
      wardsKilled: participant.wardsKilled || 0,
      visionScore: participant.visionScore || 0,
      csPerMinute: ((participant.totalMinionsKilled || 0) + (participant.neutralMinionsKilled || 0)) / Math.max(1, match.info.gameDuration / 60),
      damagePerMinute: participant.totalDamageDealtToChampions / Math.max(1, match.info.gameDuration / 60),
    }];
  });
  const aggregate = playerStats.reduce((total, stats) => Object.fromEntries(Object.keys(stats).map((key) => [key, total[key] + stats[key]])), Object.fromEntries(Object.keys(playerStats[0] || {}).map((key) => [key, 0])));
  const styleCounts = {};
  matchDetails.forEach((match) => {
    const participant = match.info.participants.find((item) => item.puuid === accountData.puuid);
    if (participant) {
      const role = participant.teamPosition || "FLEX";
      styleCounts[role] = (styleCounts[role] || 0) + 1;
    }
  });

  res.json({
    account: accountData,
    summoner: summoner.data,
    ranked: ranked.data || [],
    matches: matchDetails,
    activity,
    stats: {
      killParticipation: playerStats.length ? aggregate.killParticipation / playerStats.length : 0,
      wardsPlaced: aggregate.wardsPlaced,
      wardsKilled: aggregate.wardsKilled,
      visionScore: playerStats.length ? aggregate.visionScore / playerStats.length : 0,
      csPerMinute: playerStats.length ? aggregate.csPerMinute / playerStats.length : 0,
      damagePerMinute: playerStats.length ? aggregate.damagePerMinute / playerStats.length : 0,
      styleCounts,
    },
    nextStart: start + matches.data.length,
    hasMoreMatches: matches.data.length === count,
    champions: (mastery.data || []).map((champion) => ({
      ...champion,
      name: names[champion.championId]?.name || `Champion ${champion.championId}`,
      image: names[champion.championId]?.image,
    })),
    championCatalog: Object.values(names),
    items,
    warnings: [ranked, mastery].filter((result) => result.error).map((result) => ({ stage: result.stage, message: result.error })),
  });
});

app.listen(port, () => {
  console.log(`Riftline running at http://localhost:${port}`);
});