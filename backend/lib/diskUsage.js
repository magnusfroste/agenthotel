// Where the host's disk goes, per agent.
//
// The panel showed one number — "Disk 87%" — and Docker's own totals, so
// "has davida grown?" had no answer short of a shell (2026-10-17). This
// splits `docker system df` by owner: each agent's data (its volumes) and its
// container's writable layer, with the image it runs beside them; then the
// panel itself, what nothing owns, and the build cache.
//
// Images are shown, not summed. An image's Size counts every layer it has,
// shared or not, and Docker 29's classic builder keeps its cache as untagged
// images stacked on the same layers — summing Size counted those layers once
// per image and reported 26 GB of "reclaimable" images on a 40 GB disk. Nor
// does Size - SharedSize help: an agent's own image shares every layer with
// its own build cache and would show as nothing. So an agent's total is what
// it alone owns — its volumes and its container's writable layer — and its
// image is listed beside it at full size, marked when other agents run it
// too. Docker as a whole is LayersSize, which counts each layer once.

// The panel's own containers, and the front doors it runs beside them.
const PANEL_NAMES = /^\/?agenthotel[-_](backend|frontend|caddy|cloudflared|netbird)(-\d+)?$/;
// Its compose volumes (agenthotel_*) and the NetBird identity.
const PANEL_VOLUMES = /^agenthotel_|^agenthotel-netbird$/;

function volumeSize(v) {
  const s = v && v.UsageData ? Number(v.UsageData.Size) : 0;
  return s > 0 ? s : 0; // -1 means Docker did not measure it
}

// agents: [{ id, name, runtime, config }] (config as an object or JSON).
// projects: { [agentId]: composeProjectName } for compose-managed agents.
function diskByAgent(df, agents, projects = {}) {
  const images = df.Images || [];
  const containers = df.Containers || [];
  const volumes = df.Volumes || [];
  const imageById = new Map(images.map(i => [i.Id, i]));
  const claimedVolumes = new Set();
  const claimedContainers = new Set();

  const ownerOfContainer = (c, agent) => {
    const labels = c.Labels || {};
    if (labels['agenthotel.id'] === agent.id) return true;
    const project = projects[agent.id];
    if (project && labels['com.docker.compose.project'] === project) return true;
    return (c.Names || []).some(n => n.replace(/^\//, '') === `agenthotel-${agent.id}`);
  };
  const ownerOfVolume = (v, agent) => {
    if (v.Name.startsWith(`agenthotel-${agent.id}-`)) return true;
    const project = projects[agent.id];
    return !!project && (v.Labels || {})['com.docker.compose.project'] === project;
  };

  // Which agents run each image, to tell an agent's own image from a shared one.
  const users = new Map();
  const rows = agents.map(agent => {
    const own = containers.filter(c => ownerOfContainer(c, agent));
    own.forEach(c => claimedContainers.add(c.Id));
    const vols = volumes.filter(v => ownerOfVolume(v, agent));
    vols.forEach(v => claimedVolumes.add(v.Name));
    const imageIds = [...new Set(own.map(c => c.ImageID).filter(Boolean))];
    imageIds.forEach(id => users.set(id, new Set([...(users.get(id) || []), agent.id])));
    return {
      id: agent.id,
      name: agent.name,
      runtime: agent.runtime,
      data: vols.reduce((a, v) => a + volumeSize(v), 0),
      volumes: vols.map(v => ({ name: v.Name, size: volumeSize(v) })).sort((a, b) => b.size - a.size),
      container: own.reduce((a, c) => a + (Number(c.SizeRw) || 0), 0),
      imageIds
    };
  });

  for (const row of rows) {
    const img = row.imageIds.map(id => imageById.get(id)).filter(Boolean)[0];
    const by = img ? users.get(img.Id) : null;
    row.image = img ? {
      tag: (img.RepoTags || []).find(t => t !== '<none>:<none>') || img.Id.slice(7, 19),
      size: Number(img.Size) || 0,
      sharedWith: by ? by.size - 1 : 0
    } : null;
    // What this agent alone holds on the disk.
    row.total = row.data + row.container;
    delete row.imageIds;
  }
  rows.sort((a, b) => b.total - a.total);

  // The panel: its own containers and volumes.
  const panelContainers = containers.filter(c => !claimedContainers.has(c.Id) && (c.Names || []).some(n => PANEL_NAMES.test(n)));
  panelContainers.forEach(c => claimedContainers.add(c.Id));
  const panelVolumes = volumes.filter(v => !claimedVolumes.has(v.Name) && PANEL_VOLUMES.test(v.Name));
  panelVolumes.forEach(v => claimedVolumes.add(v.Name));
  const panel = {
    containers: panelContainers.reduce((a, c) => a + (Number(c.SizeRw) || 0), 0),
    data: panelVolumes.reduce((a, v) => a + volumeSize(v), 0)
  };
  panel.total = panel.containers + panel.data;

  const usedImageIds = new Set(containers.map(c => c.ImageID));
  const unused = images.filter(i => !usedImageIds.has(i.Id));
  const otherContainers = containers.filter(c => !claimedContainers.has(c.Id));
  const otherVolumes = volumes.filter(v => !claimedVolumes.has(v.Name));
  const buildCache = (df.BuildCache || []).reduce((a, c) => a + (Number(c.Size) || 0), 0);

  return {
    agents: rows,
    panel,
    // Counted, not sized: their sizes overlap (see above).
    unusedImages: {
      count: unused.length,
      tagged: unused.filter(i => (i.RepoTags || []).some(t => t !== '<none>:<none>')).length
    },
    other: {
      containers: otherContainers.reduce((a, c) => a + (Number(c.SizeRw) || 0), 0),
      volumes: otherVolumes.reduce((a, v) => a + volumeSize(v), 0),
      volumeCount: otherVolumes.length
    },
    buildCache,
    // Every image layer on the disk, each counted once.
    layersSize: Number(df.LayersSize) || 0,
    volumesSize: volumes.reduce((a, v) => a + volumeSize(v), 0)
  };
}

module.exports = { diskByAgent };
