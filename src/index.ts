import * as k8s from "@kubernetes/client-node";
import mc, {NewPingResult} from "minecraft-protocol";
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

interface ServerConfig {domains: string[], address: string, gateways: string[], service?: k8s.V1Service};

const informer = k8s.makeInformer(kc, "/api/v1/services", () => k8sApi.listNamespacedService(config.watchNamespace));
const localServerMap: {[key: string]: ServerConfig} = {};

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

  const bodyObject: {java: {servers: {[key: string]: ServerConfig}}} = {java: {servers: {}}};
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

const app = new Elysia();

app.post("/callback", async ({ request }) => {
  const message = JSON.parse(await request.text());
  console.log(message, message.topics[0], message.isLoginRequest);
  if (message.topics[0] === "PrePlayerJoin") {
    if (message.isLoginRequest !== true) return;

    const status = <NewPingResult>await mc.ping(message.server.serverAddress);
    if (status.version.protocol !== 0) {
      return; // already up
    }

    const linkedServer = localServerMap[message.server.serverId];
    if (!linkedServer.service || !linkedServer.service.metadata || !linkedServer.service.metadata.name || !linkedServer.service.metadata.namespace) {
      return console.log("Missing metadata");
    }
    const {body: endpoint} = await k8sApi.readNamespacedEndpoints(linkedServer.service.metadata.name, linkedServer.service.metadata.namespace);
    const subset = endpoint.subsets && endpoint.subsets[0];
    if (!subset) return console.log("Missing subsets");
    const address = subset.addresses && subset.addresses[0];
    if (!address || !address.targetRef || !address.targetRef.name || !address.targetRef.namespace) return console.log("Missing address");
    const {body: pod} = await k8sApi.readNamespacedPod(address.targetRef.name, address.targetRef.namespace);
    const ownerReference = pod.metadata?.ownerReferences && pod.metadata.ownerReferences[0];
    if (!ownerReference) return console.log("Missing pod owner reference");
    if (ownerReference.kind !== "ReplicaSet") return console.log("infrared-scaler only supports ReplicaSets for scaling for now.");
    const {body: controller} = await appApi.readNamespacedReplicaSet(ownerReference.name, address.targetRef.namespace);
    if (!controller.metadata?.ownerReferences || controller.metadata.ownerReferences[0].kind !== "StatefulSet") return console.log("Invalid replicaSet owner reference");
    const statefulSet = controller.metadata.ownerReferences[0];
    const replicas = controller.spec?.replicas;
    if (replicas === 0) {
      await appApi.patchNamespacedStatefulSetScale(statefulSet.name, controller.metadata.namespace!, [{op: "replace", path: "/spec/replicas", value: 1}]);
      console.log("Scaled up deployment");
    } else {
      console.log("No change");
    }
  }
  return "ok";
});

app.listen(3000);
console.log(
  `🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`
);

informer.start();
