

export const modelDependencies = ["project"];

export const dependencies = ["normalizeCircuitResponse","renderCircuit","renderCircuitList","setCanvasStatus","updateCapabilityState","updateSessionChrome"];

export function createController({models, ui, client, ports}) {
  const {project: projectState} = models;
function useDemo() {
    if (!projectState.demoAllowed) return;
    projectState.isDemo = true;
    projectState.session = { workspace: { name: "演示工作区" }, capabilities: { connectivity: "exact", profile: "demo-geometry" } };
    projectState.revision = "demo:half-adder-board";
    projectState.sourceChanged = false;
    projectState.capabilities = projectState.session.capabilities;
    projectState.circuits = [{ name: "half_adder" }, { name: "register_enable" }];
    projectState.circuitName = "half_adder";
    projectState.circuit = demoCircuit();
    ports.updateSessionChrome();
    ports.updateCapabilityState();
    ports.renderCircuitList();
    ports.renderCircuit();
    ui.emptyState.hidden = true;
    ports.setCanvasStatus("演示数据只用于体验选区与审阅交互，不代表目标 Logisim 运行时的观察结果。", "warning");
  }

function demoCircuit() {
    return ports.normalizeCircuitResponse({
      circuit: {
        name: "half_adder",
        bounds: { x: 60, y: 70, width: 590, height: 290 },
        components: [
          { componentId: "demo-a", factoryName: "Input Pin", label: "A", location: { x: 90, y: 150 }, bounds: { x: 80, y: 140, width: 20, height: 20 } },
          { componentId: "demo-b", factoryName: "Input Pin", label: "B", location: { x: 90, y: 260 }, bounds: { x: 80, y: 250, width: 20, height: 20 } },
          { componentId: "demo-xor", factoryName: "XOR Gate", label: "sum logic", location: { x: 320, y: 145 }, bounds: { x: 290, y: 120, width: 60, height: 50 } },
          { componentId: "demo-and", factoryName: "AND Gate", label: "carry logic", location: { x: 320, y: 270 }, bounds: { x: 290, y: 245, width: 60, height: 50 } },
          { componentId: "demo-sum", factoryName: "Output Pin", label: "SUM", location: { x: 610, y: 145 }, bounds: { x: 600, y: 135, width: 20, height: 20 } },
          { componentId: "demo-carry", factoryName: "Output Pin", label: "CARRY", location: { x: 610, y: 270 }, bounds: { x: 600, y: 260, width: 20, height: 20 } },
        ],
        wires: [
          { wireId: "dw1", netId: "demo-net-a", points: [[100, 150], [210, 150], [210, 135], [290, 135]] },
          { wireId: "dw2", netId: "demo-net-a", points: [[210, 150], [210, 260], [290, 260]] },
          { wireId: "dw3", netId: "demo-net-b", points: [[100, 260], [240, 260], [240, 155], [290, 155]] },
          { wireId: "dw4", netId: "demo-net-b", points: [[240, 260], [240, 280], [290, 280]] },
          { wireId: "dw5", netId: "demo-sum", points: [[350, 145], [600, 145]] },
          { wireId: "dw6", netId: "demo-carry", points: [[350, 270], [600, 270]] },
        ],
        nets: [
          { netId: "demo-net-a", wireIds: ["dw1", "dw2"] },
          { netId: "demo-net-b", wireIds: ["dw3", "dw4"] },
          { netId: "demo-sum", wireIds: ["dw5"] },
          { netId: "demo-carry", wireIds: ["dw6"] },
        ],
      },
    });
  }
  return Object.freeze({useDemo, demoCircuit});
}
