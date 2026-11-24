# Flake outputs for the development shell.
{ lib, pkgs, ... }:

let
  version = "1.2.3";

  # Greets a user by name.
  greet = name: "Hello, ${name}!";

  mkPackage = { name, version ? "0.1.0", src }: pkgs.stdenv.mkDerivation {
    inherit name version src;
    buildInputs = [ pkgs.hello ];
  };

  packages = {
    hello = pkgs.hello;
    custom = mkPackage { name = "custom"; src = ./src; };
  };

  nixpkgs = import <nixpkgs> { };
  cfg = import ./config.nix;
in
{
  devShell = pkgs.mkShell {
    buildInputs = with pkgs; [ git curl ];
    shellHook = greet "world";
  };

  inherit (lib) optionalString;
}
