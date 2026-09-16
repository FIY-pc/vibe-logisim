"use strict";

function dependencyPorts(names, registry) {
  return Object.freeze(Object.fromEntries(names.map(name => [name, (...args) => {
    const command = registry[name];
    if (typeof command !== "function") throw new Error(`工作区动作未注册：${name}`);
    return command(...args);
  }])));
}

export function compose(modules, context) {
  const registry = Object.create(null);
  const controllers = {};
  for (const [name, module] of Object.entries(modules)) {
    if (!Array.isArray(module.modelDependencies)) {
      throw new Error(`工作域未声明状态依赖：${name}`);
    }
    const models = Object.freeze(Object.fromEntries(module.modelDependencies.map(key => {
      if (!Object.hasOwn(context.models, key)) throw new Error(`工作域 ${name} 缺少状态：${key}`);
      return [key, context.models[key]];
    })));
    controllers[name] = module.createController({
      models,
      ui: context.ui,
      client: context.client,
      ports: dependencyPorts(module.dependencies || [], registry),
    });
  }
  for (const controller of Object.values(controllers)) {
    for (const [name, command] of Object.entries(controller)) {
      if (typeof command !== "function" || name === "mount") continue;
      if (registry[name]) throw new Error(`工作区动作重复注册：${name}`);
      registry[name] = command;
    }
  }
  // Validate the entire graph before mounting listeners or starting polling.
  // Missing dependencies must not surface only after a user clicks a button.
  for (const [name, module] of Object.entries(modules)) {
    for (const dependency of module.dependencies || []) {
      if (typeof registry[dependency] !== "function") {
        throw new Error(`工作域 ${name} 缺少动作：${dependency}`);
      }
    }
  }
  return Object.freeze({ ...controllers, commands: Object.freeze(registry) });
}
