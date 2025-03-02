import bodyParser from "body-parser";
import express from "express";
import { BASE_NODE_PORT } from "../config";
import { Value } from "../types";


// structure of state of node in consensus algorithm
type NodeState = {
  killed: boolean; //  if the node is stopped
  x: 0 | 1 | "?" | null; // current decision value
  decided: boolean | null; // final decision or not
  k: number | null; // current round number
};

// function that creates and manages a node in a consensus protocol.
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

  let killed = false; // track if the node is stopped


  // initialization of node state
  let nodeState: NodeState = {
    killed: false,
    x: isFaulty ? null : (initialValue as 0 | 1 | "?" | null),
    decided: isFaulty ? null : false,
    k: isFaulty ? null : 0,
  };


  // check status of node
  node.get("/status", (req, res) => {
    res.status(isFaulty ? 500 : 200).send(isFaulty ? "faulty" : "live");
  });


  // start consensus process
  node.get("/start", async (req, res) => {
    if (killed || isFaulty) {
      res.status(500).send("Node is faulty or stopped");
      return;
    }

    // wait until all nodes are ready before proceeding
    while (!nodesAreReady()) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    let round = 0;
    const maxRounds = 20; // limitatino of the number of rounds so we don't have infinite loops

    while (!nodeState.decided && round < maxRounds) {
      await new Promise((resolve) => setTimeout(resolve, 100));

      const votes = await gatherVotes(round); // get votes from other nodes in the current round
      const majorityVote = getMajorityVote(votes); // determination of the majority round

      if (majorityVote !== null) {
        // if majority vote is obtained, update the state of node
        nodeState.x = majorityVote as 0 | 1;
        nodeState.decided = true;
        await broadcastMessage(round, nodeState.x);
        break; // exit after reaching consensus
      } else {
        // no majority, pick a random value
        nodeState.x = Math.random() < 0.5 ? 0 : 1;
      }
      
      //update of round number
      nodeState.k = round;
      round++;
    }

    res.status(200).send("Consensus reached");
  });

  //sending the decision of a node to all of the other nodes
  async function broadcastMessage(round: number, value: 0 | 1) {
    if (isFaulty) return; // Faulty nodes do not participate

    for (let i = 0; i < N; i++) {
      if (i !== nodeId) {
        let attempts = 0;
        let success = false;

        // retry sending the message up to three times if it is necessary
        while (attempts < 3 && !success) {
          try {
            await fetch(`http://localhost:${BASE_NODE_PORT + i}/message`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ round, value }),
            });
            success = true; // the message has been send successfully
          } catch (error) {
            attempts++;
            console.error(`Failed to send message to node ${i}, attempt ${attempts}`);
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        }
      }
    }
  }

  // collection of votes from other notes in a given round.
  async function gatherVotes(round: number): Promise<number[]> {
    if (isFaulty) return []; // the faulty nodes do not participate

    const votes: number[] = [];

    for (let i = 0; i < N; i++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 500); // timeout to prevent long waits

      try {
        const response = await fetch(`http://localhost:${BASE_NODE_PORT + i}/getState`, {
          signal: controller.signal,
        });
        clearTimeout(timeout);

        const data: unknown = await response.json();
        if (isValidNodeState(data)) {
          const nodeState = data as NodeState;
          if (nodeState.x === 0 || nodeState.x === 1) {
            votes.push(nodeState.x); //ad valid votes to the list
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

  // determines the majority vote from a list of votes
  function getMajorityVote(votes: number[]): 0 | 1 | null {
    if (votes.length === 0) return null; //  if there is no votes, no decision is made

    const count0 = votes.filter((v) => v === 0).length;
    const count1 = votes.filter((v) => v === 1).length;
    const majorityThreshold = Math.floor(N / 2) + 1;

    if (count0 >= majorityThreshold) return 0;
    if (count1 >= majorityThreshold) return 1;
    
    return null; // if there is no clear majority
  }

  //to handle message from another node
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
          nodeState.decided = true; // decision if valide decision value is received
        }
      }
    });

    res.sendStatus(200);
  });

  // to stop the node
  node.get("/stop", (req, res) => {
    killed = true;
    nodeState.killed = true;
    res.status(200).send("Node stopped");
  });

  // current state of the node
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

  // validates if an object is conform to the NodeState type
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

  // Start the server for this node
  const server = node.listen(BASE_NODE_PORT + nodeId, async () => {
    console.log(`Node ${nodeId} is listening on port ${BASE_NODE_PORT + nodeId}`);
    setNodeIsReady(nodeId);
  });

  return server;
}