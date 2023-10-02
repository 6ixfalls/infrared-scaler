import * as k8s from "@kubernetes/client-node";
import { Elysia } from "elysia";

const kc = new k8s.KubeConfig();
kc.loadFromCluster();
const k8sApi = kc.makeApiClient(k8s.CoreV1Api);

const config = {
  watchNamespace: process.env.WATCH_NAMESPACE || "default",
  annotationPrefix: process.env.ANNOTATION_PREFIX || "infrared-scaler.sixfal.ls",
  infraredUrl: process.env.INFRARED_URL || "http://infrared:8080/v1",
  serverUrl: process.env.SCALER_URL || "http://infrared-scaler:3000",
  configPath: process.env.CONFIG_PATH || "/config/proxies/"
}

const informer = k8s.makeInformer(kc, "/api/v1/services", () => k8sApi.listNamespacedService(config.watchNamespace));

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
  const builtConfig = {
    domains: [domain],
    address: `${obj.metadata.name}.${obj.metadata.namespace}:${targetPort.targetPort || targetPort.port}`,
    gateways: ["default"]
  }

  if (!domain) {
    return; // No domain name, no need to process
  }

  const key = `${obj.metadata.name}-${obj.metadata.namespace}`;
  const configId = encodeURIComponent(`${config.configPath}${key}.yml`);
  const bodyObject = {java: {servers: {}}};
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

  console.log(`Updated config for ${obj.metadata.name}`);
}

informer.on("delete", async (obj) => {
  console.log("Deleted: " + obj.metadata?.name);
  if (!obj.metadata || !obj.metadata.annotations) {
    console.error("No metadata or annotations found");
    return;
  }
  const configId = encodeURIComponent(`${obj.metadata.name}-${obj.metadata.namespace}`);

  const res = await fetch(`${config.infraredUrl}/configs/${configId}`, {
    method: "DELETE",
  });

  if (!res.ok) {
    console.error(`Failed to delete config for ${obj.metadata.name}: ${res.statusText}`);
    return;
  }

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

app.post("/callback", ({ request }) => {
  console.log(request.text());
  return "ok";
});

app.listen(3000);
console.log(
  `🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`
);

informer.start();
