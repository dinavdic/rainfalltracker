import { StationConfig } from "./types";

export const STATIONS: StationConfig[] = [
  {
    code: "SFO",
    city: "San Francisco",
    cliParams: "site=MTR&product=CLI&issuedby=SFO",
    ghcnId: "USW00023234",
    lat: 37.6213,
    lon: -122.379,
  },
  {
    code: "MIA",
    city: "Miami",
    cliParams: "site=MFL&product=CLI&issuedby=MIA",
    ghcnId: "USW00012839",
    lat: 25.7959,
    lon: -80.2870,
  },
  {
    code: "DEN",
    city: "Denver",
    cliParams: "site=BOU&product=CLI&issuedby=DEN",
    ghcnId: "USW00023062",
    lat: 39.8561,
    lon: -104.6737,
  },
  {
    code: "ORD",
    city: "Chicago",
    cliParams: "site=LOT&product=CLI&issuedby=ORD",
    ghcnId: "USW00094846",
    lat: 41.9742,
    lon: -87.9073,
  },
  {
    code: "JFK",
    city: "New York",
    cliParams: "site=OKX&product=CLI&issuedby=NYC",
    ghcnId: "USW00094789",
    lat: 40.6413,
    lon: -73.7781,
  },
  {
    code: "SEA",
    city: "Seattle",
    cliParams: "site=SEW&product=CLI&issuedby=SEA",
    ghcnId: "USW00024233",
    lat: 47.4502,
    lon: -122.3088,
  },
];

export const THRESHOLDS = [1.0, 2.0, 3.0];

export const NWS_USER_AGENT = "RainfallTracker/1.0 (contact@example.com)";
