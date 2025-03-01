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

  // Initializing node state
  let nodeState: NodeState = {
    killed: false,
    x: isFaulty ? null : initialValue as 0 | 1 | "?" | null,
    decided: isFaulty ? null : false,
    k: isFaulty ? null : 0,
  };

  // Route to retrieve the current status of the node
  node.get("/status", (req, res) => {
    if (isFaulty) {
      return res.status(500).send("faulty"); // Return plain string
    }
    res.status(200).send("live"); // Return plain string
    return;
  });

  node.get("/start", async (req, res) => {
    if (killed) {
      return res.status(500).send("Node is stopped");
    }
  
    let round = 0;
  
    while (!nodeState.decided) {
      await new Promise((resolve) => setTimeout(resolve, 100)); // Simulate round delay
  
      const votes = await gatherVotes(round);
      const majorityVote = getMajorityVote(votes);
  
      if (majorityVote !== null) {
        nodeState.x = majorityVote as 0 | 1 | null; // Explicit cast
        nodeState.decided = true;
      } else {
        nodeState.x = Math.random() < 0.5 ? 0 : 1;
      }
      
  
      round++;
      nodeState.k = round;
    }
  
    res.status(200).send("Consensus reached");
    return;
  });

  async function gatherVotes(round: number): Promise<number[]> {
    const votes: number[] = [];
  
    for (let i = 0; i < N; i++) {
      try {
        const response = await fetch(`http://localhost:${BASE_NODE_PORT + i}/getState`);
        const data = await response.json();
  
        // Validate that `data` matches NodeState structure
        if (
          typeof data === "object" &&
          data !== null &&
          "x" in data &&
          "decided" in data &&
          "k" in data &&
          (data.x === 0 || data.x === 1 || data.x === "?" || data.x === null)
        ) {
          const nodeState: NodeState = data as NodeState;
  
          if (nodeState.x === 0 || nodeState.x === 1) {
            votes.push(nodeState.x);
          }
        } else {
          console.warn(`Invalid data received from node ${i}:`, data);
        }
      } catch (error) {
        console.error(`Failed to get state from node ${i}:`, error);
      }
    }
  
    return votes; // Only returns numbers now
  }
  
  
  function getMajorityVote(votes: number[]): 0 | 1 | null {
    const count0 = votes.filter((v) => v === 0).length;
    const count1 = votes.filter((v) => v === 1).length;
    const majorityThreshold = Math.floor(N / 2) + 1;
  
    if (count0 >= majorityThreshold) return 0;
    if (count1 >= majorityThreshold) return 1;
    return null; // No majority
  }
  
  

  node.post("/message", (req, res) => {
    if (killed) {
      res.status(500).send("Node is stopped");
      return;
    }
  
    const { round, value } = req.body;
  
    if (nodeState.k === null || nodeState.k < round) {
      nodeState.k = round;
      nodeState.x = value; // Update the node's current consensus value
    }
  
    res.sendStatus(200);
  });
  
  node.get("/stop", (req, res) => {
    killed = true;
    nodeState.killed = true;
    res.status(200).send("Node stopped");
  });
  

  // Route to get the current state of the node
  node.get("/getState", (req, res) => {
    res.status(200).json(nodeState);
  });

  // Start the server
  const server = node.listen(BASE_NODE_PORT + nodeId, async () => {
    console.log(`Node ${nodeId} is listening on port ${BASE_NODE_PORT + nodeId}`);

    // The node is ready
    setNodeIsReady(nodeId);
  });

  return server;
}
