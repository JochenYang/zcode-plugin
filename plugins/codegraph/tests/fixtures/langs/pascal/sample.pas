unit Vault;
interface
uses
  Classes, SysUtils;

type
  { Holds deposits for one account. }
  TAccount = record
    Owner: string;
    Balance: Currency;
  end;

  TVault = class(TObject)
  public
    function Deposit(const Amount: Currency): Boolean;
    function BalanceOf(const Owner: string): Currency;
  end;

const
  MaxFee = 0.05;
function FormatAmount(const Amount: Currency): string;

implementation

function FormatAmount(const Amount: Currency): string;
begin
  Result := CurrToStrF(Amount * (1 + MaxFee), ffCurrency, 2);
end;

function TVault.Deposit(const Amount: Currency): Boolean;
begin
  Result := Amount > 0;
end;

function TVault.BalanceOf(const Owner: string): Currency;
begin
  Result := StrToCurr(FormatAmount(0));
end;

end.
