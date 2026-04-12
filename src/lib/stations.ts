import { StationConfig } from "./types";

export const STATIONS: StationConfig[] = [
  {
    code: "SFO",
    city: "San Francisco",
    cliParams: "site=MTR&product=CLI&issuedby=SFO",
    iemCode: "SFO",
    lat: 37.6213,
    lon: -122.379,
  },
  {
    code: "LAX",
    city: "Los Angeles",
    cliParams: "site=LOX&product=CLI&issuedby=LAX",
    iemCode: "LAX",
    lat: 33.9425,
    lon: -118.4081,
  },
  {
    code: "MIA",
    city: "Miami",
    cliParams: "site=MFL&product=CLI&issuedby=MIA",
    iemCode: "MIA",
    lat: 25.7959,
    lon: -80.287,
  },
  {
    code: "DEN",
    city: "Denver",
    cliParams: "site=BOU&product=CLI&issuedby=DEN",
    iemCode: "DEN",
    lat: 39.8561,
    lon: -104.6737,
  },
  {
    code: "MDW",
    city: "Chicago",
    cliParams: "site=LOT&product=CLI&issuedby=MDW",
    iemCode: "MDW",
    lat: 41.7868,
    lon: -87.7522,
  },
  {
    code: "NYC",
    city: "New York",
    cliParams: "site=OKX&product=CLI&issuedby=NYC",
    iemCode: "NYC",
    lat: 40.7829,
    lon: -73.9654,
  },
  {
    code: "SEA",
    city: "Seattle",
    cliParams: "site=SEW&product=CLI&issuedby=SEA",
    iemCode: "SEA",
    lat: 47.4502,
    lon: -122.3088,
  },
  {
    code: "AUS",
    city: "Austin",
    cliParams: "site=EWX&product=CLI&issuedby=AUS",
    iemCode: "AUS",
    lat: 30.1945,
    lon: -97.6699,
  },
  {
    code: "DFW",
    city: "Dallas-Fort Worth",
    cliParams: "site=FWD&product=CLI&issuedby=DFW",
    iemCode: "DFW",
    lat: 32.8998,
    lon: -97.0403,
  },
  {
    code: "HOU",
    city: "Houston",
    cliParams: "site=HGX&product=CLI&issuedby=HOU",
    iemCode: "HOU",
    lat: 29.6454,
    lon: -95.2789,
  },
];

export const THRESHOLDS = [1.0, 2.0, 3.0, 4.0, 5.0];

export const NWS_USER_AGENT = "RainfallTracker/1.0 (contact@example.com)";
