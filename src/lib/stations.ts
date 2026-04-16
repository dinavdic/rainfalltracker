import { StationConfig } from "./types";

export const STATIONS: StationConfig[] = [
  {
    code: "SFO",
    city: "San Francisco",
    cliParams: "site=MTR&product=CLI&issuedby=SFO",
    iemCode: "SFO",
    lat: 37.6213,
    lon: -122.379,
    nwsGrid: { office: "MTR", gridX: 88, gridY: 126 },
  },
  {
    code: "LAX",
    city: "Los Angeles",
    cliParams: "site=LOX&product=CLI&issuedby=LAX",
    iemCode: "LAX",
    lat: 33.9425,
    lon: -118.4081,
    nwsGrid: { office: "LOX", gridX: 149, gridY: 48 },
  },
  {
    code: "MIA",
    city: "Miami",
    cliParams: "site=MFL&product=CLI&issuedby=MIA",
    iemCode: "MIA",
    lat: 25.7617,
    lon: -80.1918,
    nwsGrid: { office: "MFL", gridX: 109, gridY: 50 },
  },
  {
    code: "DEN",
    city: "Denver",
    cliParams: "site=BOU&product=CLI&issuedby=DEN",
    iemCode: "DEN",
    lat: 39.8561,
    lon: -104.6737,
    nwsGrid: { office: "BOU", gridX: 62, gridY: 60 },
  },
  {
    code: "MDW",
    city: "Chicago",
    cliParams: "site=LOT&product=CLI&issuedby=MDW",
    iemCode: "MDW",
    lat: 41.7868,
    lon: -87.7522,
    nwsGrid: { office: "LOT", gridX: 74, gridY: 70 },
  },
  {
    code: "NYC",
    city: "New York",
    cliParams: "site=OKX&product=CLI&issuedby=NYC",
    iemCode: "NYC",
    lat: 40.7829,
    lon: -73.9654,
    nwsGrid: { office: "OKX", gridX: 33, gridY: 37 },
  },
  {
    code: "SEA",
    city: "Seattle",
    cliParams: "site=SEW&product=CLI&issuedby=SEA",
    iemCode: "SEA",
    lat: 47.4502,
    lon: -122.3088,
    nwsGrid: { office: "SEW", gridX: 124, gridY: 67 },
  },
  {
    code: "AUS",
    city: "Austin",
    cliParams: "site=EWX&product=CLI&issuedby=AUS",
    iemCode: "AUS",
    lat: 30.1945,
    lon: -97.6699,
    nwsGrid: { office: "EWX", gridX: 154, gridY: 91 },
  },
  {
    code: "DFW",
    city: "Dallas-Fort Worth",
    cliParams: "site=FWD&product=CLI&issuedby=DFW",
    iemCode: "DFW",
    lat: 32.8998,
    lon: -97.0403,
    nwsGrid: { office: "FWD", gridX: 80, gridY: 108 },
  },
  {
    code: "HOU",
    city: "Houston",
    cliParams: "site=HGX&product=CLI&issuedby=HOU",
    iemCode: "HOU",
    lat: 29.6454,
    lon: -95.2789,
    nwsGrid: { office: "HGX", gridX: 65, gridY: 97 },
  },
];

export const THRESHOLDS = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0];

export const NWS_USER_AGENT = "RainfallTracker/1.0 (rainfall-tracker@example.com)";

/**
 * Kalshi series ticker candidates for each station.
 * We try multiple patterns since the exact format isn't documented.
 * The API route tries each and logs what it finds.
 */
export const KALSHI_SERIES_CANDIDATES: Record<string, string[]> = {
  NYC: ["KXRAINNYCM", "KXRAINNYM", "KXRAINNYC"],
  SFO: ["KXRAINSFOM", "KXRAINSFM", "KXRAINSFO"],
  MIA: ["KXRAINMIAM", "KXRAINMIM", "KXRAINMIA"],
  DEN: ["KXRAINDENM", "KXRAINDEM", "KXRAINDEN"],
  MDW: ["KXRAINCHIM", "KXRAINMDWM", "KXRAINCHI"],
  LAX: ["KXRAINLAXM", "KXRAINLAM", "KXRAINLAX"],
  AUS: ["KXRAINAUSM", "KXRAINAUM", "KXRAINAUS"],
  DFW: ["KXRAINDALM", "KXRAINDAL"],
  HOU: ["KXRAINHOUM", "KXRAINHOU", "KXRAINHTX"],
  SEA: ["KXRAINSEAM", "KXRAINSEM", "KXRAINSEA"],
};

/**
 * City name keywords to match Kalshi market titles to our stations.
 * Used as fallback when ticker pattern matching fails.
 */
export const KALSHI_CITY_KEYWORDS: Record<string, string[]> = {
  NYC: ["new york", "nyc", "central park"],
  SFO: ["san francisco", "sfo"],
  MIA: ["miami"],
  DEN: ["denver"],
  MDW: ["chicago", "midway"],
  LAX: ["los angeles", "lax"],
  AUS: ["austin"],
  DFW: ["dallas", "fort worth", "dfw"],
  HOU: ["houston"],
  SEA: ["seattle"],
};
