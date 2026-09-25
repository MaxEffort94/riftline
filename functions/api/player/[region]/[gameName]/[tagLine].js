const regions = {
  na1: { platformHost: "na1.api.riotgames.com", routingHost: "americas.api.riotgames.com" },
  euw1: { platformHost: "euw1.api.riotgames.com", routingHost: "europe.api.riotgames.com" },
  kr: { platformHost: "kr.api.riotgames.com", routingHost: "asia.api.riotgames.com" },
  oc1: { platformHost: "oc1.api.riotgames.com", routingHost: "sea.api.riotgames.com" },
  sg2: { platformHost: "sg2.api.riotgames.com", routingHost: "sea.api.riotgames.com" },
};

let championNames;
let itemCatalog;

const headers = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers });
}

function riotError(status, stage) {
  return {
    error: status === 401
      ? "Riot rejected the API key. Configure a new key in the RIOT_API_KEY Pages secret."
      : status === 403
        ? "Riot refused this request. Check that the API key is active and that the selected region matches the player."
        : status === 429
          ? "Riot rate limit reached. Wait a moment before loading more data."
          : status === 404
            ? "Riot could not find this player in the selected region. Check the Riot ID and tag exactly."
            : `Riot API returned HTTP ${status}.`,
    status,
    stage,
  };
}

async function riotRequest(host, endpoint, label, apiKey) {
  try {
    const response = await fetch(`https://${host}${endpoint}`, {
      headers: { "X-Riot-Token": apiKey },
    });
    if (!response.ok) return riotError(response.status, label);
    return { data: await response.json() };
  } catch (error) {
    return { error: "Could not connect to Riot API.", status: 502, details: error.message, stage: label };
  }
}

async function getChampionNames() {
  if (championNames) return championNames;
  const response = await fetch("https://ddragon.leagueoflegends.com/cdn/15.18.1/data/en_US/champion.json");
  if (!response.ok) return {};
  const payload = await response.json();
  championNames = Object.fromEntries(Object.values(payload.data).map((champion) => [
    Number(champion.key), { name: champion.name, image: champion.image.full },
  ]));
  return championNames;
}

async function getItemCatalog() {
  if (itemCatalog) return itemCatalog;
  const response = await fetch("https://ddragon.leagueoflegends.com/cdn/15.18.1/data/en_US/item.json");
  if (!response.ok) return {};
  const payload = await response.json();
  itemCatalog = Object.fromEntries(Object.entries(payload.data).map(([id, item]) => [id, {
    name: item.name, description: item.description, stats: item.stats, image: item.image.full,
  }]));
  return itemCatalog;
}

export async function onRequest(context) {
  if (context.request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: { ...headers, "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" },
    });
  }
  if (context.request.method !== "GET") return json({ error: "Method not allowed" }, 405);

  const apiKey = context.env.RIOT_API_KEY;
  if (!apiKey) return json({ error: "RIOT_API_KEY is not configured." }, 500);

  const { region, gameName, tagLine } = context.params;
  const selectedRegion = regions[region];
  if (!selectedRegion) return json({ error: "Unsupported routing region" }, 400);

  const url = new URL(context.request.url);
  const start = Math.max(0, Number.parseInt(url.searchParams.get("start"), 10) || 0);
  const count = Math.min(10, Math.max(1, Number.parseInt(url.searchParams.get("count"), 10) || 10));
  const account = await riotRequest(
    selectedRegion.routingHost,
    `/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`,
    "account lookup",
    apiKey,
  );
  if (account.error) return json({ error: account.error, stage: account.stage }, account.status);

  const accountData = account.data;
  const summoner = await riotRequest(
    selectedRegion.platformHost,
    `/lol/summoner/v4/summoners/by-puuid/${encodeURIComponent(accountData.puuid)}`,
    "summoner lookup",
    apiKey,
  );
  if (summoner.error) return json({ error: summoner.error, stage: summoner.stage }, summoner.status);

  const ranked = await riotRequest(
    selectedRegion.platformHost,
    `/lol/league/v4/entries/by-puuid/${encodeURIComponent(accountData.puuid)}`,
    "rank lookup",
    apiKey,
  );
  const matches = await riotRequest(
    selectedRegion.routingHost,
    `/lol/match/v5/matches/by-puuid/${encodeURIComponent(accountData.puuid)}/ids?start=${start}&count=${count}`,
    "match lookup",
    apiKey,
  );
  if (matches.error) return json({ error: matches.error, stage: matches.stage }, matches.status);

  const matchIds = Array.isArray(matches.data) ? matches.data : [];
  const matchDetails = (await Promise.all(matchIds.map((matchId) => riotRequest(
    selectedRegion.routingHost,
    `/lol/match/v5/matches/${encodeURIComponent(matchId)}`,
    "match detail lookup",
    apiKey,
  )))).filter((match) => match.data).map((match) => match.data);

  const timelineResults = await Promise.all(matchIds.slice(0, 3).map(async (matchId) => ({
    matchId,
    result: await riotRequest(
      selectedRegion.routingHost,
      `/lol/match/v5/matches/${encodeURIComponent(matchId)}/timeline`,
      "timeline lookup",
      apiKey,
    ),
  })));
  const timelines = timelineResults.map((item) => item.result.data).filter(Boolean);
  timelineResults.forEach(({ matchId, result }) => {
    const match = matchDetails.find((item) => (item.metadata?.matchId || item.info?.gameId) === matchId);
    if (match && result.data) match.timeline = result.data;
  });

  const mastery = await riotRequest(
    selectedRegion.platformHost,
    `/lol/champion-mastery/v4/champion-masteries/by-puuid/${encodeURIComponent(accountData.puuid)}/top?count=50`,
    "mastery lookup",
    apiKey,
  );
  const [names, items] = await Promise.all([getChampionNames(), getItemCatalog()]);
  const playerParticipantIds = new Set(matchDetails.flatMap((match) => {
    const participant = match.info?.participants?.find((item) => item.puuid === accountData.puuid);
    return participant ? [participant.participantId] : [];
  }));
  const activity = [0, 0, 0, 0];
  timelines.forEach((timeline) => (timeline.info?.frames || []).forEach((frame) => (frame.events || []).forEach((event) => {
    const minute = Math.min(3, Math.floor(event.timestamp / 600000));
    const involved = (event.participantId && playerParticipantIds.has(event.participantId))
      || (event.killerId && playerParticipantIds.has(event.killerId))
      || (event.assistingParticipantIds || []).some((id) => playerParticipantIds.has(id));
    if (involved && ["CHAMPION_KILL", "WARD_PLACED", "WARD_KILL", "ELITE_MONSTER_KILL"].includes(event.type)) activity[minute] += 1;
  })));

  const playerStats = matchDetails.flatMap((match) => {
    const participant = match.info?.participants?.find((item) => item.puuid === accountData.puuid);
    if (!participant) return [];
    const team = match.info.participants.filter((item) => item.teamId === participant.teamId);
    const teamKills = team.reduce((total, item) => total + item.kills, 0);
    const minutes = Math.max(1, match.info.gameDuration / 60);
    return [{
      kills: participant.kills, assists: participant.assists, deaths: participant.deaths,
      killParticipation: teamKills ? (participant.kills + participant.assists) / teamKills : 0,
      wardsPlaced: participant.wardsPlaced || 0, wardsKilled: participant.wardsKilled || 0,
      visionScore: participant.visionScore || 0,
      csPerMinute: ((participant.totalMinionsKilled || 0) + (participant.neutralMinionsKilled || 0)) / minutes,
      damagePerMinute: participant.totalDamageDealtToChampions / minutes,
    }];
  });
  const aggregate = playerStats.reduce((total, stats) => Object.fromEntries(
    Object.keys(stats).map((key) => [key, total[key] + stats[key]]),
  ), Object.fromEntries(Object.keys(playerStats[0] || {}).map((key) => [key, 0])));
  const styleCounts = {};
  matchDetails.forEach((match) => {
    const participant = match.info?.participants?.find((item) => item.puuid === accountData.puuid);
    if (participant) styleCounts[participant.teamPosition || "FLEX"] = (styleCounts[participant.teamPosition || "FLEX"] || 0) + 1;
  });

  return json({
    account: accountData, summoner: summoner.data, ranked: ranked.data || [], matches: matchDetails, activity,
    stats: {
      killParticipation: playerStats.length ? aggregate.killParticipation / playerStats.length : 0,
      wardsPlaced: aggregate.wardsPlaced, wardsKilled: aggregate.wardsKilled,
      visionScore: playerStats.length ? aggregate.visionScore / playerStats.length : 0,
      csPerMinute: playerStats.length ? aggregate.csPerMinute / playerStats.length : 0,
      damagePerMinute: playerStats.length ? aggregate.damagePerMinute / playerStats.length : 0, styleCounts,
    },
    nextStart: start + matchIds.length, hasMoreMatches: matchIds.length === count,
    champions: (mastery.data || []).map((champion) => ({
      ...champion, name: names[champion.championId]?.name || `Champion ${champion.championId}`,
      image: names[champion.championId]?.image,
    })),
    championCatalog: Object.values(names), items,
    warnings: [ranked, mastery].filter((result) => result.error).map((result) => ({ stage: result.stage, message: result.error })),
  });
}
