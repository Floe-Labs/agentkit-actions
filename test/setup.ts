// @coinbase/agentkit's @CreateAction decorator reads runtime metadata via
// Reflect.getMetadata. The reflect-metadata polyfill must be imported
// before any class with that decorator is evaluated.
import "reflect-metadata";
