import bodyParser from "body-parser";
import express from "express";
import { BASE_NODE_PORT } from "../config";
import { Value } from "../types";

type NodeState = {
  killed: boolean;
  x: 0 | 1 | "?" | null;
  decided: boolean | null;
  k: number | null;
};

export async function node(
  nodeId: number,
  N: number,
  F: number,
  initialValue: Value,
  isFaulty: boolean,
  nodesAreReady: () => boolean,
  setNodeIsReady: (index: number) => void
) {
  const node = express();
  node.use(express.json());
  node.use(bodyParser.json());

  let killed = false;

  let nodeState: NodeState = {
    killed: false,
    x: isFaulty ? null : (initialValue as 0 | 1 | "?" | null),
    decided: isFaulty ? null : false,
    k: isFaulty ? null : 0,
  };

  node.get("/status", (req, res) => {
    res.status(isFaulty ? 500 : 200).send(isFaulty ? "faulty" : "live");
  });

  node.get("/start", async (req, res) => {
    if (killed || isFaulty) {
      res.status(500).send("Node is faulty or stopped");
      return;
    }

    while (!nodesAreReady()) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    let round = 0;
    const maxRounds = 20; // Increase maxRounds to ensure exceeding threshold test works

    while (!nodeState.decided && round < maxRounds) {
      await new Promise((resolve) => setTimeout(resolve, 100));

      const votes = await gatherVotes(round);
      const majorityVote = getMajorityVote(votes);

      if (majorityVote !== null) {
        nodeState.x = majorityVote as 0 | 1;
        nodeState.decided = true;
        await broadcastMessage(round, nodeState.x);
        break; // Exit after consensus
      } else {
        nodeState.x = Math.random() < 0.5 ? 0 : 1; // Randomize decision
      }

      nodeState.k = round;
      round++;
    }

    res.status(200).send("Consensus reached");
  });

  async function broadcastMessage(round: number, value: 0 | 1) {
    if (isFaulty) return; // Faulty nodes do not broadcast

    for (let i = 0; i < N; i++) {
      if (i !== nodeId) {
        let attempts = 0;
        let success = false;

        while (attempts < 3 && !success) {
          try {
            await fetch(`http://localhost:${BASE_NODE_PORT + i}/message`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ round, value }),
            });
            success = true;
          } catch (error) {
            attempts++;
            console.error(`Failed to send message to node ${i}, attempt ${attempts}`);
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        }
      }
    }
  }

  async function gatherVotes(round: number): Promise<number[]> {
    if (isFaulty) return []; // Faulty nodes do not participate

    const votes: number[] = [];

    for (let i = 0; i < N; i++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 500);

      try {
        const response = await fetch(`http://localhost:${BASE_NODE_PORT + i}/getState`, {
          signal: controller.signal,
        });
        clearTimeout(timeout);

        const data: unknown = await response.json();
        if (isValidNodeState(data)) {
          const nodeState = data as NodeState;
          if (nodeState.x === 0 || nodeState.x === 1) {
            votes.push(nodeState.x);
          }
        } else {
          console.warn(`Invalid response from node ${i}:`, data);
        }
      } catch (error: unknown) {
        clearTimeout(timeout);
        console.warn(`Node ${i} unresponsive for round ${round}`);
      }
    }

    return votes;
  }

  function getMajorityVote(votes: number[]): 0 | 1 | null {
    if (votes.length === 0) return null; // No votes, no decision.

    const count0 = votes.filter((v) => v === 0).length;
    const count1 = votes.filter((v) => v === 1).length;
    const majorityThreshold = Math.floor(N / 2) + 1;

    if (count0 >= majorityThreshold) return 0;
    if (count1 >= majorityThreshold) return 1;
    
    return null; // No clear majority
  }

  node.post("/message", async (req, res) => {
    if (killed || isFaulty) {
      res.status(500).send("Node is stopped or faulty");
      return;
    }

    const { round, value } = req.body;

    setImmediate(() => {
      if (nodeState.k === null || nodeState.k < round) {
        nodeState.k = round;
        nodeState.x = value;

        if (value !== null) {
          nodeState.decided = true; // Ensure decision is locked in
        }
      }
    });

    res.sendStatus(200);
  });

  node.get("/stop", (req, res) => {
    killed = true;
    nodeState.killed = true;
    res.status(200).send("Node stopped");
  });

  node.get("/getState", (req, res) => {
    if (isFaulty) {
      res.status(200).json({
        killed: nodeState.killed,
        x: null,
        decided: null,
        k: null,
      });
      return;
    }
    res.status(200).json(nodeState);
    return;
  });

  function isValidNodeState(data: any): data is NodeState {
    return (
      typeof data === "object" &&
      data !== null &&
      "x" in data &&
      "decided" in data &&
      "k" in data &&
      "killed" in data &&
      (data.x === 0 || data.x === 1 || data.x === "?" || data.x === null) &&
      (typeof data.decided === "boolean" || data.decided === null) &&
      (typeof data.k === "number" || data.k === null) &&
      typeof data.killed === "boolean"
    );
  }

  const server = node.listen(BASE_NODE_PORT + nodeId, async () => {
    console.log(`Node ${nodeId} is listening on port ${BASE_NODE_PORT + nodeId}`);
    setNodeIsReady(nodeId);
  });

  return server;
}