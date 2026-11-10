import { register as attach } from './support.mjs';
export { attach as install };
export const launch = (value) => attach(value);
// export function fake() {}
export class Engine {
  static make(
    seed = 1,
  ) {
    return new Engine(seed);
  }

  step() {
    return launch(this);
  }
}
export default function (engine) {
  return engine.step();
}
