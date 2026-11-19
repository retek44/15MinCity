import { HEAT_RAMP } from "../scoring";

/**
 * The map's bottom band: what the colour means (the ramp as one continuous bar, because the map
 * interpolates it) and the data credit. A plane flush to the map edge, not a floating box.
 */
export function Legend({ title, dark, low, high }: { title: string; dark: boolean; low: string; high: string }) {
  const ramp = dark ? HEAT_RAMP.dark : HEAT_RAMP.light;
  return (
    <div className="map-band">
      <figure className="legend" aria-label={title}>
        <figcaption title={title}>{title}</figcaption>
        <span className="legend-scale" aria-hidden="true">
          <span>{low}</span>
          <span className="legend-bar" style={{ background: `linear-gradient(to right, ${ramp.join(", ")})` }} />
          <span>{high}</span>
        </span>
      </figure>
      <p className="credit">
        <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">
          © OpenStreetMap
        </a>{" "}
        <span className="credit-extra">
          · Protomaps ·{" "}
          <a href="https://spacedata.copernicus.eu/collections/copernicus-digital-elevation-model" target="_blank" rel="noreferrer">
            Copernicus DEM
          </a>{" "}
          · Reach15
        </span>
      </p>
    </div>
  );
}
