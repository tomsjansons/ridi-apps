import * as pgQueries from "@ridi/db-queries";
import { type RidiLogger } from "@ridi/logger";
import { type Messaging } from "@ridi/messaging";
import {
  planWiderRetryMax,
  type RouteReq,
} from "@ridi/router-service-contracts";
import type postgres from "postgres";

import { type RouterServiceLookup } from "./router-service-lookup";

export class MessageHandlerNewPlan {
  private readonly logger: RidiLogger;
  private readonly pgClient: postgres.Sql;
  private readonly routerServiceLookup: RouterServiceLookup;
  private readonly messaging: Messaging;

  constructor(
    logger: RidiLogger,
    pgClient: postgres.Sql,
    routerServiceLookup: RouterServiceLookup,
    messaging: Messaging,
  ) {
    this.logger = logger.withContext({ module: "message-handler-new-plan" });
    this.pgClient = pgClient;
    this.routerServiceLookup = routerServiceLookup;
    this.messaging = messaging;
  }

  async onNewPlanError(planId: string) {
    await pgQueries.planSetState(this.pgClient, {
      id: planId,
      state: "error",
    });
  }

  async handleNewPlan(
    planId: string,
    widerReqNum: number | null,
  ): Promise<void> {
    const planRecord = await pgQueries.planGetById(this.pgClient, {
      id: planId,
    });
    if (!planRecord) {
      this.logger.warn("Plan record not found from id", { planId });
      return;
    }

    if (planRecord.isDeleted) {
      return;
    }

    if (planRecord.tripType === "round-trip") {
      if (
        Number(planRecord.bearing).toString() !== planRecord.bearing ||
        Number(planRecord.distance).toString() !== planRecord.distance ||
        Number(planRecord.startLat).toString() !== planRecord.startLat ||
        Number(planRecord.startLon).toString() !== planRecord.startLon
      ) {
        throw this.logger.error(
          "Plan record validation failed for 'round-trip'",
          {
            planId,
            ...planRecord,
          },
        );
      }
    } else {
      if (
        Number(planRecord.startLat).toString() !== planRecord.startLat ||
        Number(planRecord.startLon).toString() !== planRecord.startLon ||
        Number(planRecord.finishLat).toString() !== planRecord.finishLat ||
        Number(planRecord.finishLon).toString() !== planRecord.finishLon
      ) {
        throw this.logger.error(
          "Plan record validation failed for 'start-finish'",
          {
            planId,
            ...planRecord,
          },
        );
      }
    }

    await pgQueries.planSetState(this.pgClient, {
      id: planId,
      state: widerReqNum ? "planning-wider" : "planning",
    });

    const regionsFrom = await pgQueries.regionFindFromCoords(this.pgClient, {
      lat: planRecord.startLat,
      lon: planRecord.startLon,
    });
    const regionsTo =
      planRecord.finishLat && planRecord.finishLon
        ? await pgQueries.regionFindFromCoords(this.pgClient, {
            lat: planRecord.finishLat,
            lon: planRecord.finishLon,
          })
        : null;

    const region = regionsTo
      ? regionsTo.find((r) => regionsFrom.find((rr) => rr.region === r.region))
      : regionsFrom[0];

    if (!region) {
      throw this.logger.error("Region not found", {
        planId: planRecord.id,
      });
    }

    await pgQueries.planSetRegion(this.pgClient, {
      id: planRecord.id,
      region: region.region,
    });

    const rules = await pgQueries.ruleSetRoadTagsListByRuleSetIdWithDeleted(
      this.pgClient,
      {
        ruleSetId: planRecord.ruleSetId,
        userId: planRecord.userId,
      },
    );

    const ruleInput = rules.reduce(
      (all, curr) => {
        all[curr.tagKey as keyof RouteReq["rules"]] = curr.value;
        return all;
      },
      {} as RouteReq["rules"],
    );

    this.logger.info("Starting router service request ", {
      planId,
      region: region.region,
      ruleInput,
    });

    const result = await this.routerServiceLookup.callRouterService(
      region.region,
      {
        reqId: planRecord.id,
        widerReqNum,
        req:
          planRecord.tripType === "start-finish"
            ? {
                tripType: "start-finish",
                start: {
                  lat: Number(planRecord.startLat),
                  lon: Number(planRecord.startLon),
                },
                finish: {
                  lat: Number(planRecord.finishLat),
                  lon: Number(planRecord.finishLon),
                },
              }
            : {
                tripType: "round-trip",
                startFinish: {
                  lat: Number(planRecord.startLat),
                  lon: Number(planRecord.startLon),
                },
                brearing: Number(planRecord.bearing),
                distance: Number(planRecord.distance),
              },
        rules: ruleInput,
      },
    );

    if (result.status !== 200) {
      if (
        result.status === 500 &&
        result.body.message.includes("PointNotFound")
      ) {
        await pgQueries.planSetState(this.pgClient, {
          id: planId,
          state: "done",
        });
        return;
      }
      throw this.logger.error("Router service response error", {
        result,
        planId,
        region: region.region,
      });
    }
    const okRoutes = result.body.routes;
    this.logger.info("Router Client finished", {
      planId,
      region: region.region,
    });

    const distanceModifier = planRecord.tripType === "round-trip" ? 1 : 2;
    const distance = Number(planRecord.distance);
    const sort = (a: (typeof okRoutes)[number], b: (typeof okRoutes)[number]) =>
      b.stats.score - a.stats.score;
    const filter =
      (fromMod: number | null, toMod: number | null) =>
      (r: (typeof okRoutes)[number]) =>
        (!fromMod || r.stats.lenM > distance * distanceModifier * fromMod) &&
        (!toMod || r.stats.lenM <= distance * distanceModifier * toMod);
    const filterBucketLevels = [
      filter(0, 1),
      filter(1, 1.5),
      filter(1.5, 2),
      filter(2, 2.5),
      filter(2.5, 3),
      filter(3, 0),
    ];

    const okRoutesInDistBuckets = filterBucketLevels.map((filter) =>
      okRoutes.filter(filter).sort(sort),
    );
    const numOfBestRoutes = 8;
    const bestRoutes: typeof okRoutes = [];

    while (
      bestRoutes.length < numOfBestRoutes &&
      okRoutesInDistBuckets.some((bucket) => bucket.length > 0)
    ) {
      for (const distBucket of okRoutesInDistBuckets) {
        const bestRoute = distBucket.shift();
        if (bestRoute) {
          bestRoutes.push(bestRoute);
          if (bestRoutes.length === numOfBestRoutes) {
            break;
          }
        }
      }
    }

    if (
      !bestRoutes.length &&
      (!widerReqNum || widerReqNum < planWiderRetryMax)
    ) {
      await this.messaging.send("plan_new", {
        planId,
        widerRetryNum: (widerReqNum || 0) + 1,
      });
      await pgQueries.planSetState(this.pgClient, {
        id: planId,
        state: "planning-wider",
      });
      return;
    }

    for (const route of bestRoutes) {
      const routeRecord = await pgQueries.routeInsert(this.pgClient, {
        planId,
        name: "some name",
        userId: planRecord.userId,
        latLonArray: route.route,
        statsLenM: route.stats.lenM.toString(),
        statsJunctionCount: route.stats.junctionCount.toString(),
        statsScore: route.stats.score.toString(),
      });
      if (!routeRecord) {
        throw this.logger.error("Newly inserted route record must exist", {
          planId,
          planRecord,
          routeRecord,
        });
      }

      await this.messaging.send("route_map_gen", { routeId: routeRecord.id });

      for (const statBreakdown of route.stats.breakdown) {
        await pgQueries.routeBreakdownStatsInsert(this.pgClient, {
          userId: planRecord.userId,
          routeId: routeRecord.id,
          statType: statBreakdown.statType,
          statName: statBreakdown.statName,
          lenM: statBreakdown.lenM.toString(),
          percentage: statBreakdown.percentage.toString(),
        });
      }
    }

    await pgQueries.planSetState(this.pgClient, {
      id: planId,
      state: "done",
    });
  }
}
