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

interface ServerConfig { domains: string[], address: string, gateways: string[], service?: k8s.V1Service };

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
    gateways: ["default"]
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
  if (!statefulSet.spec || !statefulSet.spec.serviceName) {
    return console.log("StatefulSet missing spec");
  }
  statefulSetMap[statefulSet.spec.serviceName] = statefulSet;
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

      //const status: NewPingResult = await mc.ping(message.data.server.serverAddress);
      //console.log(status);
      //if (status.version.protocol !== 0) {
      //  return; // already up
      //}

      const linkedServer = localServerMap[message.data.server.serverId];
      if (!linkedServer.service || !linkedServer.service.metadata || !linkedServer.service.metadata.name) return console.log("Missing metadata");
      const statefulSet = statefulSetMap[linkedServer.service.metadata.name];
      if (!statefulSet || !statefulSet.spec || !statefulSet.metadata || !statefulSet.metadata.name || !statefulSet.metadata.namespace) return console.log("Missing statefulSet");
      const replicas = statefulSet.spec.replicas;
      console.log(replicas);
      if (replicas === 0) {
        await appApi.patchNamespacedStatefulSetScale(statefulSet.metadata.name, statefulSet.metadata.namespace, { spec: { replicas: 1 } }, undefined, undefined, undefined, undefined, undefined, {
          headers: {
            'Content-Type': 'application/merge-patch+json',
            'Accept': 'application/json, */*',
          },
        }).then(console.log).catch((e) => console.log("fail: ", e.statusCode, e.body));
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
