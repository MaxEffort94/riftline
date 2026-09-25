let matchData = [];
let championData = [];
let currentSearch = null;
let nextStart = 10;
let loadingMore = false;
let rawMatches = [];
let itemCatalog = {};
let championCatalog = {};
const dataDragonVersion = "15.18.1";

const matchesEl = document.querySelector("#matches");
const championsEl = document.querySelector("#champions");
const filterButtons = document.querySelectorAll(".filter");
const savedSearchKey = "riftline:last-search";

document.querySelector(".brand")?.addEventListener("click", () => {
  localStorage.removeItem(savedSearchKey);
});

function showDashboard() {
  document.querySelector("#welcome-panel").hidden = true;
  document.querySelector(".dashboard-tabs").hidden = false;
  document.querySelector(".profile-column").hidden = false;
  document.querySelector(".content-column").hidden = false;
  document.querySelectorAll(".wide-panel").forEach((panel) => { panel.hidden = false; });
}

function championInitials(name) {
  return name.slice(0, 2).toUpperCase();
}

function iconUrl(iconId) {
  return `https://ddragon.leagueoflegends.com/cdn/${dataDragonVersion}/img/profileicon/${iconId}.png`;
}

function itemIconUrl(fileName) {
  return `https://ddragon.leagueoflegends.com/cdn/${dataDragonVersion}/img/item/${fileName}`;
}

function championIconUrl(fileName) {
  return `https://ddragon.leagueoflegends.com/cdn/${dataDragonVersion}/img/champion/${fileName}`;
}

function championMarkup(name, className = "champion-portrait") {
  const normalizedName = String(name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const image = championCatalog[name] || championCatalog[normalizedName];
  if (!image) return "";
  return `<span class="champion-image-wrap"><img class="${className}" src="${championIconUrl(image)}" alt="${escapeHtml(name)} portrait" loading="lazy" onerror="this.parentElement.remove()"></span>`;
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[character]));
}

function itemMarkup(itemId) {
  const item = itemCatalog[itemId];
  const fallback = item || { name: `Item ${itemId}`, description: "Item details are not available in this Data Dragon version.", stats: {}, image: `${itemId}.png` };
  if (String(itemId) === "0") return "";
  const description = escapeHtml(fallback.description.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim());
  const statLabels = {
    FlatHPPoolMod: "Health",
    FlatPhysicalDamageMod: "Attack Damage",
    FlatMagicDamageMod: "Ability Power",
    FlatArmorMod: "Armor",
    FlatSpellBlockMod: "Magic Resist",
    PercentAttackSpeedMod: "Attack Speed",
    PercentMovementSpeedMod: "Move Speed",
    PercentLifeStealMod: "Life Steal",
    FlatCritChanceMod: "Critical Strike",
  };
  const stats = Object.entries(fallback.stats || {}).map(([key, value]) => {
    const formatted = key.startsWith("Percent") ? `${Math.round(value * 100)}%` : Math.round(value);
    return `${statLabels[key] || key}: ${formatted}`;
  }).join(" · ");
  return `<span class="item-chip" tabindex="0"><img src="${itemIconUrl(fallback.image)}" alt="${escapeHtml(fallback.name)}" onerror="this.parentElement.remove()"><span class="item-tooltip"><strong>${escapeHtml(fallback.name)}</strong>${stats ? `<em>${escapeHtml(stats)}</em>` : ""}<small>${description || "No description available."}</small></span></span>`;
}

function avatarMarkup(iconId, name, className = "player-avatar") {
  return iconId
    ? `<img class="${className}" src="${iconUrl(iconId)}" alt="${name} profile picture" loading="lazy">`
    : `<span class="${className} fallback-avatar">${name.slice(0, 1).toUpperCase()}</span>`;
}

function renderMatches(filter = "all") {
  const visible = matchData.filter((match) => filter === "all" || (filter === "wins" ? match.win : !match.win));
  matchesEl.innerHTML = visible.length ? visible.map((match) => `
    <article class="match ${match.win ? "" : "loss"}" data-match-id="${match.id || ""}" tabindex="0" role="button" aria-label="View details for ${match.champ} match">
      <div class="match-time">${match.time}</div>
      <div class="result ${match.win ? "win" : "loss"}">${match.result}<small>${match.mode}</small></div>
      <div class="match-champ">${championMarkup(match.champ)}<span class="champ-name">${match.champ}<small>${match.role}</small></span></div>
      <div class="kda">${match.kda}<br><b>${match.cs}</b></div>
    </article>
  `).join("") : `<p class="empty-state match-empty">${currentSearch ? "No recent matches found for this player." : "Search a player to load recent matches."}</p>`;
  matchesEl.querySelectorAll(".match").forEach((row) => {
    row.addEventListener("click", () => openMatchDetails(row.dataset.matchId, row));
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openMatchDetails(row.dataset.matchId, row);
      }
    });
  });
}

function renderChampions() {
  championsEl.innerHTML = championData.length ? championData.map((champion) => `
    <article class="champion">
      ${championMarkup(champion.name)}
      <div class="champion-name"><strong>${champion.name}</strong><span>${champion.games} · ${champion.points} mastery</span></div>
      <div class="champion-stat">${champion.win}<small>WIN RATE</small></div>
    </article>
  `).join("") : `<p class="empty-state">Search a player to load champion mastery.</p>`;
}

function formatDuration(seconds) {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

function formatAge(timestamp) {
  const minutes = Math.max(1, Math.round((Date.now() - timestamp) / 60000));
  if (minutes < 60) return `${minutes} MIN`;
  if (minutes < 1440) return `${Math.round(minutes / 60)} HRS`;
  return "YESTERDAY";
}

function applyLiveData(data) {
  matchData = (data.matches || []).flatMap((match) => {
    const participant = match.info.participants.find((item) => item.puuid === data.account.puuid);
    if (!participant) return [];
    return [{
      id: match.metadata?.matchId || match.info.gameId,
      detail: match,
      time: formatAge(match.info.gameCreation),
      result: participant.win ? "Victory" : "Defeat",
      mode: `${match.info.gameMode} · ${formatDuration(match.info.gameDuration)}`,
      champ: participant.championName,
      role: participant.teamPosition || "FLEX",
      kda: `${participant.kills} / ${participant.deaths} / ${participant.assists}`,
      cs: `${participant.totalMinionsKilled || 0} CS`,
      win: participant.win,
    }];
  });
  championData = (data.champions || []).map((champion) => ({
    name: champion.name,
    games: `${champion.championLevel} level`,
    win: "—",
    points: `${Math.round(champion.championPoints / 1000)}k`,
  }));
  itemCatalog = data.items || {};
  championCatalog = Object.fromEntries((data.championCatalog || []).flatMap((champion) => {
    const normalizedName = champion.name.toLowerCase().replace(/[^a-z0-9]/g, "");
    return [[champion.name, champion.image], [normalizedName, champion.image]];
  }));
  renderMastery(data.champions || []);
  renderRanks(data.ranked || []);
  renderPlayStyle(data.stats || {});
  const games = matchData.length;
  const wins = matchData.filter((match) => match.win).length;
  const totals = matchData.reduce((sum, match) => {
    const [kills, deaths, assists] = match.kda.split(" / ").map(Number);
    return { kills: sum.kills + kills, deaths: sum.deaths + deaths, assists: sum.assists + assists };
  }, { kills: 0, deaths: 0, assists: 0 });
  document.querySelector("#games").textContent = games;
  document.querySelector("#win-rate").textContent = games ? `${((wins / games) * 100).toFixed(1)}%` : "—";
  document.querySelector("#kda").textContent = totals.deaths ? ((totals.kills + totals.assists) / totals.deaths).toFixed(1) : "—";
  const metrics = data.stats || {};
  document.querySelector("#kill-participation").textContent = `${Math.round((metrics.killParticipation || 0) * 100)}%`;
  document.querySelector("#vision-score").textContent = (metrics.visionScore || 0).toFixed(1);
  document.querySelector("#ward-score").textContent = `${metrics.wardsPlaced || 0} / ${metrics.wardsKilled || 0}`;
  document.querySelector("#cs-per-minute").textContent = (metrics.csPerMinute || 0).toFixed(1);
  document.querySelector("#damage-per-minute").textContent = Math.round(metrics.damagePerMinute || 0).toLocaleString();
  const activity = data.activity || [0, 0, 0, 0];
  const maxActivity = Math.max(1, ...activity);
  document.querySelector("#heatmap").innerHTML = activity.map((value) =>
    `<span class="heatmap-cell" style="--heat:${(0.12 + (value / maxActivity) * 0.88).toFixed(2)}" title="${value} activity events"></span>`
  ).join("");
  nextStart = data.nextStart || 10;
  const loadMore = document.querySelector("#load-more");
  loadMore.disabled = !data.hasMoreMatches;
  loadMore.textContent = data.hasMoreMatches ? "Load older matches ↓" : "No older matches available";
  renderMatches();
  renderChampions();
  document.querySelector("#mini-chart").hidden = false;
}

function renderMastery(champions) {
  document.querySelector("#mastery-list").innerHTML = champions.map((champion) => `
    <div class="mastery-row"><span class="mastery-icon">${championInitials(champion.name)}</span><div class="mastery-copy"><strong>${champion.name}</strong><small>Level ${champion.championLevel} · ${champion.championPoints.toLocaleString()} points</small><span class="mastery-bar"><i style="width:${Math.min(100, (champion.championPointsSinceLastLevel / Math.max(1, champion.championPointsUntilNextLevel)) * 100)}%"></i></span></div><b>${champion.championPoints.toLocaleString()}</b></div>
  `).join("") || `<p class="empty-state">No champion mastery data returned.</p>`;
}

function renderRanks(ranked) {
  document.querySelector("#rank-list").innerHTML = ranked.map((entry) => `
    <div class="rank-card"><span class="rank-queue">${entry.queueType === "RANKED_SOLO_5x5" ? "RANKED SOLO" : entry.queueType === "RANKED_FLEX_SR" ? "RANKED FLEX" : entry.queueType.replaceAll("_", " ")}</span><strong>${entry.tier} ${entry.rank}</strong><small>${entry.leaguePoints} LP · ${entry.wins}W / ${entry.losses}L · ${Math.round((entry.wins / Math.max(1, entry.wins + entry.losses)) * 100)}% win rate</small></div>
  `).join("") || `<p class="empty-state">No ranked queues found.</p>`;
}

function renderPlayStyle(stats) {
  const counts = stats.styleCounts || {};
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0) || 1;
  document.querySelector("#style-list").innerHTML = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([role, count]) => `
    <div class="style-row"><div><strong>${role === "UTILITY" ? "SUPPORT" : role}</strong><small>${count} of ${total} recent games</small></div><span class="style-bar"><i style="width:${(count / total) * 100}%"></i></span><b>${Math.round((count / total) * 100)}%</b></div>
  `).join("") || `<p class="empty-state">Play style appears after your match history loads.</p>`;
}

function matchAnalysisMarkup(match, participants, teams) {
  const timeline = match.timeline?.info;
  const frames = timeline?.frames || [];
  const teamIds = teams;
  const teamName = (teamId) => teamId === teamIds[0] ? "Blue" : "Red";
  const goldRows = frames.map((frame) => {
    const totals = teamIds.map((teamId) => participants.filter((item) => item.teamId === teamId).reduce((sum, item) => {
      const frameParticipant = frame.participantFrames?.[item.participantId];
      return sum + (frameParticipant?.totalGold || 0);
    }, 0));
    return { minute: Math.round((frame.timestamp || 0) / 60000), lead: totals[0] - totals[1], totals };
  }).filter((row) => row.totals.some(Boolean));
  const maxLead = Math.max(1, ...goldRows.map((row) => Math.abs(row.lead)));
  const eventRows = frames.flatMap((frame) => (frame.events || []).map((event) => ({
    minute: Math.round((event.timestamp || frame.timestamp || 0) / 60000),
    label: event.type === "CHAMPION_KILL" ? "Champion takedown" : event.type === "ELITE_MONSTER_KILL" ? `${event.monsterType || "Monster"} secured` : event.type === "BUILDING_KILL" ? "Turret destroyed" : event.type === "WARD_PLACED" ? "Ward placed" : event.type === "WARD_KILL" ? "Ward cleared" : event.type.replaceAll("_", " ").toLowerCase(),
  }))).filter((event) => ["Champion takedown", "Turret destroyed", "Ward placed", "Ward cleared"].includes(event.label)).slice(-18);
  const phaseCounts = [0, 0, 0, 0];
  eventRows.forEach((event) => { phaseCounts[Math.min(3, Math.floor(event.minute / 10))] += 1; });
  const totalKills = teams.map((teamId) => participants.filter((item) => item.teamId === teamId).reduce((sum, item) => sum + item.kills, 0));
  const objectiveKills = teams.map((teamId) => {
    const team = match.info.teams?.find((item) => item.teamId === teamId);
    return (team?.objectives?.tower?.kills || 0) + (team?.objectives?.inhibitor?.kills || 0);
  });
  const buildRows = participants.map((item) => {
    const name = item.summonerName || item.riotIdGameName || "Player";
    const items = [item.item0, item.item1, item.item2, item.item3, item.item4, item.item5].filter(Boolean);
    return `<div class="build-row"><div class="build-player">${avatarMarkup(item.profileIcon, name, "participant-avatar")}<span>${name}</span></div><span class="build-champion">${championMarkup(item.championName, "participant-champion-portrait")}</span><div class="build-items">${items.map(itemMarkup).join("") || '<span class="build-empty">No items</span>'}</div></div>`;
  }).join("");
  const goldMarkup = goldRows.length
    ? `<div class="gold-chart">${goldRows.map((row) => `<div class="gold-point" style="height:${Math.max(8, Math.abs(row.lead) / maxLead * 100)}%" title="${row.minute}m · ${row.lead >= 0 ? "Blue" : "Red"} +${Math.abs(row.lead).toLocaleString()} gold"><span></span></div>`).join("")}</div><div class="analysis-legend"><span class="blue-text">BLUE LEAD</span><span>Gold difference by minute</span><span class="red-text">RED LEAD</span></div>`
    : '<p class="empty-state">Gold lead data is unavailable for this match timeline.</p>';
  return `<div class="match-analysis"><div class="analysis-tabs" role="tablist"><button class="analysis-tab active" data-analysis-tab="gold" type="button">Gold lead</button><button class="analysis-tab" data-analysis-tab="teams" type="button">Team analysis</button><button class="analysis-tab" data-analysis-tab="builds" type="button">Players builds</button><button class="analysis-tab" data-analysis-tab="timeline" type="button">Timeline heat map</button></div><div class="analysis-panel active" data-analysis-panel="gold">${goldMarkup}</div><div class="analysis-panel" data-analysis-panel="teams"><div class="analysis-team-grid">${teams.map((teamId, index) => `<div class="analysis-team-card ${index === 0 ? "blue-card" : "red-card"}"><strong>${teamName(teamId)} team</strong><span>${totalKills[index]} kills · ${objectiveKills[index]} structures</span><small>${participants.filter((item) => item.teamId === teamId).reduce((sum, item) => sum + (item.visionScore || 0), 0)} total vision score</small></div>`).join("")}</div></div><div class="analysis-panel" data-analysis-panel="builds"><div class="build-list">${buildRows}</div></div><div class="analysis-panel" data-analysis-panel="timeline"><div class="timeline-heatmap">${phaseCounts.map((count, index) => `<div class="timeline-phase" style="--heat:${Math.min(1, count / Math.max(1, ...phaseCounts))}" title="${count} events"><span>${index === 0 ? "0–10" : index === 1 ? "10–20" : index === 2 ? "20–30" : "30+"}</span></div>`).join("")}</div>${eventRows.length ? `<div class="event-list">${eventRows.map((event) => `<div><b>${event.minute}m</b><span>${event.label}</span></div>`).join("")}</div>` : '<p class="empty-state">Timeline events are unavailable for this match.</p>'}</div></div>`;
}

function openMatchDetails(matchId, row) {
  const match = rawMatches.find((item) => (item.metadata?.matchId || item.info.gameId) === matchId);
  if (!match) return;
  const existing = matchesEl.querySelector(`[data-match-details="${matchId}"]`);
  if (existing) {
    existing.remove();
    row?.setAttribute("aria-expanded", "false");
    return;
  }
  const participants = match.info.participants;
  const player = participants.find((item) => item.puuid === currentSearch?.puuid);
  const teams = [...new Set(participants.map((item) => item.teamId))];
  const playerTeamId = player?.teamId;
  const duration = formatDuration(match.info.gameDuration);
  const participantRow = (item) => {
        const name = item.summonerName || item.riotIdGameName || "Player";
        const items = [item.item0,item.item1,item.item2,item.item3,item.item4,item.item5].filter(Boolean);
        return `<div class="team-player ${item.puuid === currentSearch?.puuid ? "you" : ""}"><div class="team-player-main">${avatarMarkup(item.profileIcon, name, "participant-avatar")}<span class="team-player-name">${name}</span></div><span class="participant-champion">${championMarkup(item.championName, "participant-champion-portrait")}</span><span class="team-kda">${item.kills} / ${item.deaths} / ${item.assists}</span><span class="team-stat">${(item.totalMinionsKilled || 0) + (item.neutralMinionsKilled || 0)} CS</span><span class="team-stat">${Math.round((item.totalDamageDealtToChampions || 0) / 1000)}k DMG</span><span class="team-items">${items.map(itemMarkup).join("")}</span></div>`;
      };
  const detail = document.createElement("section");
  detail.className = "match-details";
  detail.dataset.matchDetails = matchId;
  detail.innerHTML = `
    <div class="inline-detail-header"><div><span class="eyebrow">MATCH DETAIL / ${match.info.gameMode.toUpperCase()}</span><strong>${player?.win ? "Victory" : "Defeat"} · ${player?.championName || "Match"}</strong><small>${duration} · ${new Date(match.info.gameCreation).toLocaleString()} · ${match.info.mapName || "Summoner's Rift"}</small></div><div class="${player?.win ? "win" : "loss"} inline-result">${player?.win ? "WIN" : "LOSS"}<small>${player?.kills || 0} / ${player?.deaths || 0} / ${player?.assists || 0}</small></div></div>
    <div class="teams-grid">${teams.map((teamId, index) => {
      const team = participants.filter((item) => item.teamId === teamId);
      const won = team[0]?.win;
      const ally = teamId === playerTeamId;
      return `<div class="team-column ${ally ? "ally-team" : "enemy-team"}"><div class="team-heading"><strong class="${won ? "win" : "loss"}">${ally ? "ALLY TEAM" : "ENEMY TEAM"} · ${won ? "VICTORY" : "DEFEAT"}</strong><span>${team.reduce((sum, item) => sum + item.kills, 0)} kills</span></div><div class="team-labels"><span>PLAYER</span><span>CHAMP</span><span>KDA</span><span>CS</span><span>DMG</span><span>ITEMS</span></div>${team.map(participantRow).join("")}</div>`;
    }).join("")}</div>
    <div class="inline-objectives">Towers: ${(match.info.teams || []).map((team) => team.objectives?.tower?.kills || 0).join(" · ")} &nbsp; Baron: ${(match.info.teams || []).reduce((sum, team) => sum + (team.objectives?.baron?.kills || 0), 0)} &nbsp; Dragons: ${(match.info.teams || []).reduce((sum, team) => sum + (team.objectives?.dragon?.kills || 0), 0)}</div>
    ${matchAnalysisMarkup(match, participants, teams)}`;
  row?.after(detail);
  row?.setAttribute("aria-expanded", "true");
  detail.querySelectorAll("[data-analysis-tab]").forEach((button) => button.addEventListener("click", (event) => {
    event.stopPropagation();
    detail.querySelectorAll("[data-analysis-tab]").forEach((tab) => tab.classList.toggle("active", tab === button));
    detail.querySelectorAll("[data-analysis-panel]").forEach((panel) => panel.classList.toggle("active", panel.dataset.analysisPanel === button.dataset.analysisTab));
  }));
}

async function loadOlderMatches() {
  if (!currentSearch || loadingMore || document.querySelector("#load-more").disabled) return;
  loadingMore = true;
  const button = document.querySelector("#load-more");
  button.textContent = "Loading older matches…";
  try {
    const response = await fetch(`/api/player/${currentSearch.region}/${encodeURIComponent(currentSearch.gameName)}/${encodeURIComponent(currentSearch.tagLine)}?start=${nextStart}&count=10`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not load older matches.");
    rawMatches = [...rawMatches, ...(data.matches || [])];
    applyLiveData({ ...data, matches: rawMatches, champions: data.champions || [], stats: data.stats, activity: data.activity });
  } catch (error) {
    alert(error.message);
    button.textContent = "Load older matches ↓";
  } finally {
    loadingMore = false;
  }
}

filterButtons.forEach((button) => button.addEventListener("click", () => {
  filterButtons.forEach((item) => item.classList.remove("active"));
  button.classList.add("active");
  renderMatches(button.dataset.filter);
}));

document.querySelector("#search-form").addEventListener("submit", async (event) => {
  event.preventDefault();

  const input = document.querySelector("#player-search").value.trim();
  const region = document.querySelector("#region").value;

  if (!input.includes("#")) {
    alert("Enter a Riot ID in the format Name#Tag");
    return;
  }

  const [gameName, tagLine] = input.split("#");
  localStorage.setItem(savedSearchKey, JSON.stringify({ input, region }));

  let response;
  try {
    response = await fetch(
      `/api/player/${region}/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`
    );
  } catch {
    alert("Riftline server is not running. Start it with: node server.js");
    return;
  }

  const data = await response.json().catch(() => ({}));
  if (!data.account || !data.account.gameName || !data.account.puuid) {
    localStorage.removeItem(savedSearchKey);
    const message = data.error
      || (data.message === "Hello, world!"
        ? "The Cloudflare API function is still the Hello World test. Deploy the Riot API function at /api/player."
        : "The Riot API endpoint returned an incomplete player response. Configure the Cloudflare API function and RIOT_API_KEY.");
    alert(message);
    return;
  }
  if (!response.ok) {
    const message = response.status === 403
      ? `${data.error || "Riot refused this request."}${data.stage ? ` Failed during: ${data.stage}.` : ""}`
      : response.status === 404
      ? "Player not found. Use the current Riot ID exactly as Name#Tag, and choose the region where that account plays."
      : data.error || `Riot API returned HTTP ${response.status}.`;
    alert(message);
    return;
  }

  document.querySelector("#player-name").textContent = data.account.gameName;
  document.querySelector("#player-tag").textContent =
    `#${data.account.tagLine}`;

  if (data.warnings?.length) {
    console.warn("Riot API warnings:", data.warnings);
  }

  const soloRank = data.ranked.find(
    (queue) => queue.queueType === "RANKED_SOLO_5x5"
  );

  if (soloRank) {
    document.querySelector("#player-rank").textContent =
      `${soloRank.tier} ${soloRank.rank}`;

    document.querySelector("#player-lp").innerHTML =
      `${soloRank.leaguePoints} LP`;
  } else {
    document.querySelector("#player-rank").textContent = "UNRANKED";
    document.querySelector("#player-lp").textContent = "No solo queue rank";
  }

  document.querySelector("#player-region").textContent = region.toUpperCase();
  document.querySelector("#profile-avatar").innerHTML = avatarMarkup(data.summoner.profileIconId, data.account.gameName);
  currentSearch = { region, gameName, tagLine, puuid: data.account.puuid };
  showDashboard();
  rawMatches = data.matches || [];
  applyLiveData(data);
  document.querySelector("footer span:last-child").textContent = "Live Riot API data";
});

document.querySelector("#load-more").addEventListener("click", loadOlderMatches);
document.querySelectorAll(".dashboard-tab").forEach((tab) => tab.addEventListener("click", () => {
  document.querySelectorAll(".dashboard-tab").forEach((item) => item.classList.toggle("active", item === tab));
  document.querySelectorAll(".tab-panel").forEach((panel) => panel.classList.toggle("active", panel.dataset.panel === tab.dataset.tab || panel.dataset.panel === "overview" && tab.dataset.tab === "overview"));
}));

document.querySelector("#theme-toggle").addEventListener("click", () => {
  document.body.classList.toggle("light");
});

renderMatches();
renderChampions();

const homeNavigation = new URLSearchParams(window.location.search).has("home");
if (homeNavigation) {
  localStorage.removeItem(savedSearchKey);
  document.querySelector("#player-search").value = "";
  window.history.replaceState({}, "", window.location.pathname);
}

let savedSearch = null;
try {
  savedSearch = homeNavigation ? null : JSON.parse(localStorage.getItem(savedSearchKey) || "null");
} catch {
  localStorage.removeItem(savedSearchKey);
}
if (savedSearch?.input && savedSearch?.region) {
  document.querySelector("#player-search").value = savedSearch.input;
  document.querySelector("#region").value = savedSearch.region;
  document.querySelector("#search-form").requestSubmit();
}
