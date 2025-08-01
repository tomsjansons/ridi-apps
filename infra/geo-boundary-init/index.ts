import * as docker_build from "@pulumi/docker-build";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

import { getPbfLocation, mapDataVersionDateNext, regions } from "../config";
import {
  containerRegistryUrl,
  ghcrSecret,
  ridiNamespace,
  stackName,
} from "../k8s";
import { ridiDataVolumeSetup } from "../storage";
import { getNameSafe, getSafeResourceName } from "../util";

const projectName = pulumi.getProject();
const config = new pulumi.Config();

const geoBoundaryInitName = "geo-boundaries-init";
const latestTag = pulumi.interpolate`${containerRegistryUrl}/${projectName}/${geoBoundaryInitName}`;

const geoBoundaryInitImage = new docker_build.Image(geoBoundaryInitName, {
  tags: [latestTag],
  context: {
    location: "../",
  },
  dockerfile: {
    location: "./geo-boundary-init/Dockerfile",
  },
  cacheFrom: [
    {
      registry: {
        ref: latestTag,
      },
    },
  ],
  cacheTo: [
    {
      registry: {
        ref: latestTag,
      },
    },
  ],
  platforms: ["linux/amd64"],
  push: true,
  registries: [
    {
      address: containerRegistryUrl,
      password: config.requireSecret("container_registry_password"),
      username: config.require("container_registry_username"),
    },
  ],
});

function calculateCronSchedule(jobIndex: number) {
  const baseHour = 16;
  const baseMinute = 0;

  const delayMinutes = jobIndex * 3;

  const totalMinutes = baseMinute + delayMinutes;
  const additionalHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const hour = (baseHour + additionalHours) % 24;

  return { cron: `${minutes} ${hour} 24 * *` };
}

regions.forEach((region, regionIdx) => {
  const { cron } = calculateCronSchedule(regionIdx);
  const geoBoundaryJobName = getSafeResourceName(
    `geo-boundaries-${getNameSafe(region.region)}`,
  );

  new k8s.batch.v1.CronJob(geoBoundaryJobName, {
    metadata: {
      name: geoBoundaryJobName,
      namespace: ridiNamespace.metadata.name,
      labels: {
        name: geoBoundaryJobName,
      },
    },
    spec: {
      timeZone: "Etc/UTC",
      schedule: cron,
      concurrencyPolicy: "Forbid",
      successfulJobsHistoryLimit: 0,
      failedJobsHistoryLimit: 0,
      jobTemplate: {
        spec: {
          backoffLimit: 10,
          template: {
            spec: {
              restartPolicy: "OnFailure",
              containers: [
                {
                  name: geoBoundaryJobName,
                  image: geoBoundaryInitImage.ref,
                  env: [
                    {
                      name: "REGION",
                      value: region.region,
                    },
                    {
                      name: "PBF_LOCATION",
                      value: getPbfLocation(
                        region.region,
                        mapDataVersionDateNext,
                      ),
                    },
                    {
                      name: "SUPABASE_DB_URL",
                      value: config.requireSecret("supabase_db_url_stateful"),
                    },
                    {
                      name: "RIDI_ENV",
                      value: "prod",
                    },
                  ],
                  resources: {
                    requests: {
                      memory: "2000Mi",
                    },
                  },
                  volumeMounts: [ridiDataVolumeSetup.volumeMount],
                },
              ],
              volumes: [ridiDataVolumeSetup.volume],
              imagePullSecrets: [
                {
                  name: ghcrSecret.metadata.name,
                },
              ],
            },
          },
        },
      },
    },
  });
});
