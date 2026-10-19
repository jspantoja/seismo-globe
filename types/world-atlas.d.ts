// The TopoJSON files are large: declare them loosely so TypeScript does not
// infer a type from hundreds of kilobytes of coordinates.
declare module 'world-atlas/countries-50m.json' {
  const topology: any;
  export default topology;
}
