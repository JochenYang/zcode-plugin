program Greeter;

type
  TGreeter = class
    Name: string;
    function Greet: string;
  end;

function TGreeter.Greet: string;
begin
  Result := 'Hello, ' + Name + '!';
end;

var
  Greeter: TGreeter;
begin
  Greeter := TGreeter.Create;
  Greeter.Name := 'world';
  WriteLn(Greeter.Greet);
end.
