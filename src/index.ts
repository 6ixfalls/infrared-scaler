import * as k8s from "@kubernetes/client-node";
import mc, { NewPingResult } from "minecraft-protocol";
import { Elysia } from "elysia";

const kc = new k8s.KubeConfig();
kc.loadFromCluster();
const k8sApi = kc.makeApiClient(k8s.CoreV1Api);
const appApi = kc.makeApiClient(k8s.AppsV1Api);

const config = {
  watchNamespace: process.env.WATCH_NAMESPACE || "default",
  annotationPrefix: process.env.ANNOTATION_PREFIX || "infrared-scaler.sixfal.ls",
  infraredUrl: process.env.INFRARED_URL || "http://infrared:8080/v1",
  serverUrl: process.env.SCALER_URL || "http://infrared-scaler:3000",
  configPath: process.env.CONFIG_PATH || "/config/proxies/"
}

interface ServerConfig { domains: string[], address: string, gateways: string[], service?: k8s.V1Service, dialTimeoutStatus: { versionName: string, protocolNumber: number, maxPlayerCount: number, playerCount: number, motd: string; }, dialTimeoutMessage: string, dialTimeout: string };

const informer = k8s.makeInformer(kc, "/api/v1/services", () => k8sApi.listNamespacedService(config.watchNamespace));
const statefulSetInformer = k8s.makeInformer(kc, "/apis/apps/v1/statefulsets", () => appApi.listNamespacedStatefulSet(config.watchNamespace));
const localServerMap: { [key: string]: ServerConfig } = {};
const statefulSetMap: { [serviceName: string]: k8s.V1StatefulSet } = {};

async function updateService(obj: k8s.V1Service) {
  if (!obj.metadata || !obj.metadata.annotations) {
    console.error("No metadata or annotations found");
    return;
  }
  if (!obj.spec || !obj.spec.ports) {
    console.error("No spec found");
    return;
  }

  const targetPort = obj.spec.ports.find((port) => port.protocol === "TCP");
  if (!targetPort) {
    console.error("No target port found");
    return;
  }

  const domain = obj.metadata.annotations[`${config.annotationPrefix}/domainName`];
  const builtConfig: ServerConfig = {
    domains: [domain],
    address: `${obj.metadata.name}.${obj.metadata.namespace}:${targetPort.targetPort || targetPort.port}`,
    gateways: ["default"],
    dialTimeout: "1s",
    dialTimeoutMessage: "§8Hello, §a{{username}}§8!\n§8The server you are trying to reach, §3§l{{requestedAddress}}§r§8, is currently unreachable.\n§7If the server is offline, the server is in maintenance or being started. Please try again in a minute.\n§8§lSponsored by §3§lsixfal.ls",
    dialTimeoutStatus: {
      versionName: "Unreachable",
      protocolNumber: 0,
      maxPlayerCount: 0,
      playerCount: 0,
      motd: "§8{{requestedAddress}} is unreachable.§r\n§c§lSponsored by §3§lsixfal.ls§r§c§l."
    }
  }

  const statefulSet = statefulSetMap[obj.metadata.name];
  if (statefulSet && statefulSet.status) {
    console.log(statefulSet.spec.replicas, statefulSet.status.replicas, statefulSet.spec.replicas > statefulSet.status.replicas, statefulSet.spec.replicas === 0, statefulSet.status.replicas === 0);
    if (statefulSet.spec.replicas && statefulSet.status.replicas && statefulSet.spec.replicas > statefulSet.status.replicas) {
      builtConfig.dialTimeoutStatus = {
        versionName: "Waking",
        protocolNumber: 0,
        maxPlayerCount: 0,
        playerCount: 0,
        motd: "§8{{requestedAddress}} is starting.§r\n§c§lSponsored by §3§lsixfal.ls§r§c§l."
      };
      builtConfig.dialTimeoutMessage = "§8Hello, §a{{username}}§8!\n§8The server you are trying to reach, §3§l{{requestedAddress}}§r§8, is currently being started.\n§7Please try again in a minute.\n§8§lSponsored by §3§lsixfal.ls";
      builtConfig.dialTimeout = "1s";
    } else if (statefulSet.spec.replicas === 0 && statefulSet.status.replicas === 0) {
      builtConfig.dialTimeoutStatus = {
        versionName: "Sleeping",
        protocolNumber: 0,
        maxPlayerCount: 0,
        playerCount: 0,
        motd: "§8{{requestedAddress}} is asleep.§r\n§c§lSponsored by §3§lsixfal.ls§r§c§l."
      };
      builtConfig.dialTimeoutMessage = "§8Hello, §a{{username}}§8!\n§8The server you are trying to reach, §3§l{{requestedAddress}}§r§8, has been queued for a start.\n§7Please try again in a minute.\n§8§lSponsored by §3§lsixfal.ls";
      builtConfig.dialTimeout = "1s";
    }
  } else {
    console.log("No statefulSet found");
  }

  const key = `${obj.metadata.name}-${obj.metadata.namespace}`;
  const configId = encodeURIComponent(`${config.configPath}${key}.yml`);

  if (!domain) {
    const res = await fetch(`${config.infraredUrl}/configs/${configId}`, {
      method: "GET",
    });
    if (res.ok) {
      const delRes = await fetch(`${config.infraredUrl}/configs/${configId}`, {
        method: "DELETE",
      });
      if (!delRes.ok) {
        console.error(`Failed to delete config for ${obj.metadata.name}: ${delRes.statusText}`);
        return;
      }

      delete localServerMap[key];
      console.log(`Deleted config for ${obj.metadata.name}`);
    }
    return; // No domain name, no need to process
  }

  const bodyObject: { java: { servers: { [key: string]: ServerConfig } } } = { java: { servers: {} } };
  bodyObject.java.servers[key] = builtConfig;

  const res = await fetch(`${config.infraredUrl}/configs/${configId}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(bodyObject),
  });

  if (!res.ok) {
    console.error(`Failed to update config for ${obj.metadata.name}: ${res.statusText}`);
    return;
  }

  builtConfig.service = obj;
  localServerMap[key] = builtConfig;
  console.log(`Updated config for ${obj.metadata.name}`);
}

informer.on("delete", async (obj) => {
  console.log("Deleted: " + obj.metadata?.name);
  if (!obj.metadata || !obj.metadata.annotations) {
    console.error("No metadata or annotations found");
    return;
  }
  const key = `${obj.metadata.name}-${obj.metadata.namespace}`;
  const configId = encodeURIComponent(`${config.configPath}${key}.yml`);

  const res = await fetch(`${config.infraredUrl}/configs/${configId}`, {
    method: "DELETE",
  });

  if (!res.ok) {
    console.error(`Failed to delete config for ${obj.metadata.name}: ${res.statusText}`);
    return;
  }

  delete localServerMap[key];
  console.log(`Deleted config for ${obj.metadata.name}`);
});

informer.on("add", updateService);
informer.on("update", updateService);

informer.on("error", (err) => {
  console.error(err);
  setTimeout(() => {
    informer.start();
  }, 10000);
});

function updateStatefulSet(statefulSet: k8s.V1StatefulSet) {
  if (!statefulSet.spec || !statefulSet.spec.serviceName || !statefulSet.metadata || !statefulSet.metadata.namespace) {
    return console.log("StatefulSet missing spec");
  }
  statefulSetMap[statefulSet.spec.serviceName] = statefulSet;

  const builtConfig = localServerMap[`${statefulSet.spec.serviceName}-${statefulSet.metadata.namespace}`];
  if (builtConfig && statefulSet.status) {
    console.log(statefulSet.status);
    updateService(builtConfig.service);
  }
}

statefulSetInformer.on("delete", function (statefulSet) {
  if (!statefulSet.spec || !statefulSet.spec.serviceName) {
    return console.log("StatefulSet missing spec");
  }
  delete statefulSetMap[statefulSet.spec.serviceName];
})

statefulSetInformer.on("add", updateStatefulSet);
statefulSetInformer.on("update", updateStatefulSet);

statefulSetInformer.on("error", (err) => {
  console.error(err);
  setTimeout(() => {
    statefulSetInformer.start();
  }, 10000);
});

statefulSetInformer.start();

const app = new Elysia();

app.post("/callback", async ({ request }) => {
  try {
    const message = JSON.parse(await request.text());
    if (message.topics[0] === "PrePlayerJoin") {
      if (message.data.isLoginRequest !== true) return;

      const linkedServer = localServerMap[message.data.server.serverId];
      if (!linkedServer.service || !linkedServer.service.metadata || !linkedServer.service.metadata.name) return console.log("Missing metadata");
      const statefulSet = statefulSetMap[linkedServer.service.metadata.name];
      if (!statefulSet || !statefulSet.spec || !statefulSet.metadata || !statefulSet.metadata.name || !statefulSet.metadata.namespace) return console.log("Missing statefulSet");
      const replicas = statefulSet.spec.replicas;
      if (replicas === 0) {
        await appApi.patchNamespacedStatefulSetScale(statefulSet.metadata.name, statefulSet.metadata.namespace, { spec: { replicas: 1 } }, undefined, undefined, undefined, undefined, undefined, {
          headers: {
            'Content-Type': 'application/merge-patch+json',
            'Accept': 'application/json, */*',
          },
        });
        console.log("Scaled up deployment");
      } else {
        console.log("No change");
      }
    }
  } catch (e) {
    console.error(e);
  }
  return "ok";
});

app.listen(3000);
console.log(
  `🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`
);

informer.start();
